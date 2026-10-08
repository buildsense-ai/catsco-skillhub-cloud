import { generateId, sha256, ValidationError } from "../domain/index.js";
import { assertPresentationEditor, parsePresentationWrite, publicPresentation } from "./index.js";
import { assertPresentationAssets } from "./asset-store.js";

const visibleVersion = "v.status = 'published' AND v.yanked_at IS NULL";
const joinedFields = "v.skill_id, v.version, v.content_hash, v.owner_user_id, p.*";

// Feature-local readiness: do not gate legacy catalogue, auth or /readyz.
// No cached failure: applying 008 makes the next request usable immediately.
export async function ensurePresentationSchema(query) {
  const result = await query(`SELECT to_regclass('skill_presentations') IS NOT NULL
    AND to_regclass('skill_presentation_revisions') IS NOT NULL AS ready`);
  if (result.rows[0]?.ready !== true) {
    throw new ValidationError("Skill presentation storage is not ready; apply database migration 008.", "presentation.schema_unavailable", 503);
  }
}

function missing() {
  throw new ValidationError("Skill presentation not found.", "presentation.not_found", 404);
}

function editable(row) {
  return {
    skillId: row.skill_id,
    version: row.version,
    sourceContentHash: row.content_hash || null,
    revision: row.revision || 0,
    draft: row.draft_content || null,
    draftOrigin: row.draft_origin || null,
    published: publicPresentation(row)
  };
}

export function createPresentationStore({ query, tx }) {
  return {
    async getSkillPresentation({ skillId, version, actor, draft = false }) {
      await ensurePresentationSchema(query);
      const result = await query(`SELECT ${joinedFields}
        FROM skill_versions v LEFT JOIN skill_presentations p ON p.package_version_id = v.id
        WHERE v.skill_id = $1 AND v.version = $2 AND ${visibleVersion}`, [skillId, version]);
      const row = result.rows[0];
      if (!row) missing();
      if (draft) {
        assertPresentationEditor(actor, row.owner_user_id);
        return editable(row);
      }
      return publicPresentation(row);
    },

    async writeSkillPresentation(input, actor, action, ip = "") {
      if (!["draft", "publish", "unpublish"].includes(action)) throw new Error("Invalid presentation action");
      const parsed = parsePresentationWrite(input, action);
      await ensurePresentationSchema(query);
      return tx(async (client) => {
        // Lock the version even before a presentation exists: concurrent first
        // drafts and package yanks serialize on the same immutable identity.
        const versionResult = await client.query(`SELECT * FROM skill_versions v
          WHERE v.skill_id = $1 AND v.version = $2 AND ${visibleVersion} FOR UPDATE`, [parsed.skillId, parsed.version]);
        const version = versionResult.rows[0];
        if (!version) missing();
        assertPresentationEditor(actor, version.owner_user_id, parsed.reason, true);
        const current = (await client.query("SELECT * FROM skill_presentations WHERE package_version_id = $1", [version.id])).rows[0];
        if ((current?.revision || 0) !== parsed.expectedRevision) {
          throw new ValidationError("Presentation changed; reload before saving.", "presentation.revision_conflict", 409);
        }
        if (action !== "draft" && !current) {
          throw new ValidationError("Save a draft first.", "presentation.draft_required", 409);
        }
        const revision = (current?.revision || 0) + 1;
        const content = action === "draft" ? parsed.content : current.draft_content;
        if (action !== "unpublish") await assertPresentationAssets(client.query.bind(client), version.id, content);
        const draftOrigin = action === "draft" ? (actor.userId === version.owner_user_id ? "author" : "admin") : current.draft_origin;
        const published = action === "publish" ? content : action === "unpublish" ? null : current?.published_content || null;
        const publishedOrigin = action === "publish" ? draftOrigin : action === "unpublish" ? null : current?.published_origin || null;
        const publishedRevision = action === "publish" ? revision : action === "unpublish" ? null : current?.published_revision || null;
        const publishedAt = action === "publish" ? new Date().toISOString() : action === "unpublish" ? null : current?.published_at || null;
        const saved = await client.query(`INSERT INTO skill_presentations
          (package_version_id, revision, draft_content, published_content, published_revision, published_at, draft_origin, published_origin)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (package_version_id) DO UPDATE SET revision = EXCLUDED.revision,
            draft_content = EXCLUDED.draft_content, published_content = EXCLUDED.published_content,
            published_revision = EXCLUDED.published_revision, published_at = EXCLUDED.published_at,
            draft_origin = EXCLUDED.draft_origin, published_origin = EXCLUDED.published_origin, updated_at = now()
          RETURNING *`, [version.id, revision, JSON.stringify(content), published ? JSON.stringify(published) : null, publishedRevision, publishedAt, draftOrigin, publishedOrigin]);
        await client.query(`INSERT INTO skill_presentation_revisions
          (package_version_id, revision, action, content, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
        [version.id, revision, action, JSON.stringify(content), actor.userId, parsed.reason]);
        // Audit must commit atomically. No draft text, credentials or raw IP in
        // generic audit logs; full revisions are private records above.
        await client.query(`INSERT INTO audit_logs
          (id, actor_user_id, actor_role, action, resource_type, resource_id, metadata, ip)
          VALUES ($1,$2,$3,$4,'skill_presentation',$5,$6,$7)`, [
          generateId("audit"), actor.userId, actor.role, `presentation.${action}`, version.id,
          JSON.stringify({ revision, contentHash: sha256(JSON.stringify(content)), adminOverride: actor.userId !== version.owner_user_id }),
          ip ? sha256(ip).slice(0, 16) : ""
        ]);
        return editable({ ...version, ...saved.rows[0] });
      });
    }
  };
}
