import { randomBytes } from "node:crypto";
import { generateId, sha256, ValidationError } from "../domain/index.js";
import { assertPresentationEditor, parsePresentationAssetId, parsePresentationAssetWrite, parsePresentationTarget } from "./index.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, IMAGE_MAX_PIXELS } from "./images.js";

export const ASSET_VERSION_MAX_COUNT = 64;
export const ASSET_VERSION_MAX_BYTES = 64 * 1024 * 1024;
export const ASSET_ACTOR_MAX_BYTES = 256 * 1024 * 1024;
export const ASSET_UPLOADS_PER_MINUTE = 10;
const visible = "v.status = 'published' AND v.yanked_at IS NULL";
const fields = "a.id, a.width, a.height, octet_length(a.data) AS size, a.created_at";

export async function ensurePresentationAssetSchema(query) {
  const result = await query("SELECT to_regclass('skill_presentation_assets') IS NOT NULL AS ready");
  if (result.rows[0]?.ready !== true) throw new ValidationError("Apply database migration 009 for presentation images.", "presentation.assets_schema_unavailable", 503);
}

function missing() { throw new ValidationError("Presentation image not found.", "presentation.asset_not_found", 404); }
function metadata(row) {
  return { id: row.id, width: row.width, height: row.height, size: row.size, mimeType: "image/webp", createdAt: new Date(row.created_at).toISOString() };
}

async function editorVersion(query, target, actor, { reason = "", writing = false, lock = false } = {}) {
  const { skillId, version } = parsePresentationTarget(target);
  const row = (await query(`SELECT v.* FROM skill_versions v WHERE v.skill_id = $1 AND v.version = $2 AND ${visible}${lock ? " FOR UPDATE" : ""}`, [skillId, version])).rows[0];
  if (!row) missing();
  assertPresentationEditor(actor, row.owner_user_id, reason, writing);
  return row;
}

async function quota(query, versionId, actorId, bytes = 0) {
  const row = (await query(`SELECT
    count(*) FILTER (WHERE package_version_id = $1)::int AS count,
    coalesce(sum(octet_length(data)) FILTER (WHERE package_version_id = $1),0)::bigint AS version_bytes,
    coalesce(sum(octet_length(data)) FILTER (WHERE actor_user_id = $2),0)::bigint AS actor_bytes,
    (SELECT count(*)::int FROM audit_logs WHERE actor_user_id = $2 AND action = 'presentation.asset.upload'
      AND created_at > now() - interval '1 minute') AS recent
    FROM skill_presentation_assets WHERE package_version_id = $1 OR actor_user_id = $2`, [versionId, actorId])).rows[0];
  if (row.count >= ASSET_VERSION_MAX_COUNT || Number(row.version_bytes) + bytes > ASSET_VERSION_MAX_BYTES
      || Number(row.actor_bytes) + bytes > ASSET_ACTOR_MAX_BYTES || row.recent >= ASSET_UPLOADS_PER_MINUTE) {
    throw new ValidationError("Image upload quota reached. Remove unused uploads or try later.", "presentation.asset_quota", 429);
  }
}

export async function assertPresentationAssets(query, versionId, content) {
  const ids = (content?.images || []).map(({ assetId }) => assetId);
  if (!ids.length) return;
  await ensurePresentationAssetSchema(query);
  const rows = (await query("SELECT id FROM skill_presentation_assets WHERE package_version_id = $1 AND id = ANY($2::text[])", [versionId, ids])).rows;
  if (rows.length !== ids.length) missing();
}

async function audit(query, actor, action, version, assetId, reason, ip) {
  await query(`INSERT INTO audit_logs (id,actor_user_id,actor_role,action,resource_type,resource_id,metadata,ip)
    VALUES ($1,$2,$3,$4,'skill_presentation_asset',$5,$6,$7)`, [generateId("audit"), actor.userId, actor.role,
    `presentation.asset.${action}`, assetId, JSON.stringify({ packageVersionId: version.id, reason, adminOverride: actor.userId !== version.owner_user_id }), ip ? sha256(ip).slice(0, 16) : ""]);
}

export function createPresentationAssetStore({ query, tx }) {
  return {
    async checkPresentationAssetUpload(target, actor) {
      await ensurePresentationAssetSchema(query);
      await editorVersion(query, target, actor, { writing: true, reason: target.reason });
    },

    async createPresentationAsset(target, actor, image, ip = "") {
      const parsed = parsePresentationAssetWrite(target, false);
      if (!Buffer.isBuffer(image?.data) || !image.data.length || image.data.length > IMAGE_MAX_BYTES
          || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
          || image.width > IMAGE_MAX_DIMENSION || image.height > IMAGE_MAX_DIMENSION || image.width * image.height > IMAGE_MAX_PIXELS) {
        throw new ValidationError("Invalid normalized image.", "presentation.image_invalid", 400);
      }
      await ensurePresentationAssetSchema(query);
      return tx(async (client) => {
        const q = client.query.bind(client);
        const version = await editorVersion(q, parsed, actor, { writing: true, reason: parsed.reason, lock: true });
        const hash = sha256(image.data);
        const existing = (await q(`SELECT ${fields} FROM skill_presentation_assets a WHERE package_version_id = $1 AND content_sha256 = $2`, [version.id, hash])).rows[0];
        if (existing) return metadata(existing);
        // Also serialize different versions uploaded by the same authenticated
        // person: concurrent requests cannot overrun the actor's storage budget.
        await q("SELECT id FROM users WHERE id = $1 FOR UPDATE", [actor.userId]);
        await quota(q, version.id, actor.userId, image.data.length);
        const id = `pa_${randomBytes(16).toString("hex")}`;
        const row = (await q(`INSERT INTO skill_presentation_assets AS a
          (id,package_version_id,actor_user_id,content_sha256,width,height,data) VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING ${fields}`, [id, version.id, actor.userId, hash, image.width, image.height, image.data])).rows[0];
        await audit(q, actor, "upload", version, id, parsed.reason, ip);
        return metadata(row);
      });
    },

    async listPresentationAssets(target, actor) {
      await ensurePresentationAssetSchema(query);
      const version = await editorVersion(query, target, actor);
      const rows = (await query(`SELECT ${fields} FROM skill_presentation_assets a WHERE package_version_id = $1 ORDER BY created_at, id LIMIT $2`, [version.id, ASSET_VERSION_MAX_COUNT])).rows;
      return rows.map(metadata);
    },

    async getPresentationAsset(id, { actor, draft = false, viewer = null } = {}) {
      parsePresentationAssetId(id);
      await ensurePresentationAssetSchema(query);
      const viewerUserId = viewer?.userId ?? null;
      const viewerCatsCoUid = viewer?.developerProfile?.catsCoUid ?? null;
      const includeAll = Boolean(viewer?.permissions?.includes("system.manage"));
      // Public access requires a reference in the CURRENT published content.
      // No filesystem URLs, old revision URLs or browser caching can bypass it.
      const row = (await query(`SELECT ${fields}, a.data, v.owner_user_id FROM skill_presentation_assets a
        JOIN skill_versions v ON v.id = a.package_version_id
        LEFT JOIN skills s ON s.id = v.skill_id
        LEFT JOIN skill_visibility_grants g ON g.skill_id = s.id AND g.catsco_uid = $5
        LEFT JOIN skill_presentations p ON p.package_version_id = v.id
        WHERE a.id = $1 AND ${visible}
        AND ($2::boolean OR (
          coalesce(p.published_content->'images','[]'::jsonb) @> $3::jsonb
          AND ($6::boolean OR coalesce(s.visibility_scope, 'public') = 'public'
            OR ($4::text IS NOT NULL AND coalesce(s.owner_user_id, v.owner_user_id) = $4)
            OR ($5::text IS NOT NULL AND coalesce(s.visibility_scope, 'public') = 'shared' AND g.catsco_uid IS NOT NULL))))`,
      [id, draft, JSON.stringify([{ assetId: id }]), viewerUserId, viewerCatsCoUid, includeAll])).rows[0];
      if (!row) missing();
      if (draft) assertPresentationEditor(actor, row.owner_user_id);
      return { ...metadata(row), data: row.data };
    },

    async deletePresentationAsset(id, input, actor, ip = "") {
      parsePresentationAssetId(id);
      const parsed = parsePresentationAssetWrite(input, false);
      await ensurePresentationAssetSchema(query);
      return tx(async (client) => {
        const q = client.query.bind(client);
        const version = await editorVersion(q, parsed, actor, { writing: true, reason: parsed.reason, lock: true });
        const asset = (await q("SELECT id FROM skill_presentation_assets WHERE id = $1 AND package_version_id = $2", [id, version.id])).rows[0];
        if (!asset) missing();
        // Only never-used uploads can be discarded. Preserve immutable history.
        const used = await q(`SELECT 1 FROM skill_presentation_revisions
          WHERE package_version_id = $1 AND coalesce(content->'images','[]'::jsonb) @> $2::jsonb LIMIT 1`, [version.id, JSON.stringify([{ assetId: id }])]);
        if (used.rows.length) throw new ValidationError("This image is retained by presentation history.", "presentation.asset_in_use", 409);
        await q("DELETE FROM skill_presentation_assets WHERE id = $1", [id]);
        await audit(q, actor, "delete", version, id, parsed.reason, ip);
        return { deleted: true };
      });
    }
  };
}
