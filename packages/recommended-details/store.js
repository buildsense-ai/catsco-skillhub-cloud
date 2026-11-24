import { randomUUID } from "node:crypto";
import { compareSemver, ValidationError } from "../domain/index.js";
import { publicPresentation } from "../presentations/index.js";

const attemptLimit = 3;

async function currentSources(query, skillId = null, includeContent = false) {
  const { rows } = await query(`SELECT v.id, v.skill_id, v.version,
      COALESCE(NULLIF(v.content_hash, ''), v.checksum_sha256) AS source_hash,
      d.status, d.attempts, d.due_at <= now() AS due, d.failure_code, d.published_at,
      d.revision AS published_revision${includeContent ? ', d.content AS published_content' : ''}
    FROM catalogue_recommendations r
    JOIN skills s ON s.id = ANY(r.skill_ids) AND s.visibility_scope = 'public'
    JOIN skill_versions v ON v.skill_id = s.id AND v.status = 'published' AND v.yanked_at IS NULL
    LEFT JOIN recommended_skill_details d ON d.package_version_id = v.id
      AND d.source_hash = COALESCE(NULLIF(v.content_hash, ''), v.checksum_sha256)
    WHERE r.id AND ($1::text IS NULL OR s.id = $1)
    ORDER BY array_position(r.skill_ids, s.id), v.published_at DESC, v.id`, [skillId]);
  const latest = new Map();
  for (const row of rows) {
    const previous = latest.get(row.skill_id);
    if (!previous || compareSemver(row.version, previous.version) > 0) latest.set(row.skill_id, row);
  }
  return [...latest.values()];
}

export function createRecommendedDetailStore({ query, tx }) {
  return {
    async listRecommendedDetails() {
      return (await currentSources(query)).map((row) => ({
        skillId: row.skill_id, version: row.version,
        status: row.status === 'running' && row.due && row.attempts >= attemptLimit ? 'failed' : row.status ?? 'queued',
        ...(row.failure_code ? { failureCode: row.failure_code } : {}),
        publishedAt: row.published_at?.toISOString() ?? null
      }));
    },
    async retryRecommendedDetail(skillId) {
      return tx(async (client) => {
        await client.query('SELECT id FROM catalogue_recommendations WHERE id FOR UPDATE');
        const [row] = await currentSources(client.query.bind(client), skillId);
        if (!row) throw new ValidationError('仅可为公开的推荐 Skill 生成详情。', 'recommendation.detail_not_found', 404);
        const result = await client.query(`UPDATE recommended_skill_details SET status='queued', attempts=0,
          lease_id=NULL, due_at=now(), failure_code=NULL
          WHERE package_version_id=$1 AND source_hash=$2 AND (status IN ('ready','failed')
            OR (status='running' AND due_at<=now() AND attempts >= $3))`, [row.id, row.source_hash, attemptLimit]);
        if (!result.rowCount) throw new ValidationError('详情已排队或正在生成。', 'recommendation.detail_pending', 409);
      });
    },
    async claimRecommendedDetail() {
      return tx(async (client) => {
        await client.query('SELECT id FROM catalogue_recommendations WHERE id FOR UPDATE');
        const sources = await currentSources(client.query.bind(client));
        const row = sources.find(({ status, due, attempts }) => !status
          || ((status === 'queued' || status === 'running') && due && attempts < attemptLimit));
        if (!row) return null;
        const lease = randomUUID();
        await client.query(`INSERT INTO recommended_skill_details AS d
          (package_version_id, source_hash, status, attempts, lease_id, due_at)
          VALUES ($1,$2,'running',1,$3,now()+interval '3 minutes')
          ON CONFLICT (package_version_id) DO UPDATE SET source_hash=excluded.source_hash, status='running',
            attempts=CASE WHEN d.source_hash=excluded.source_hash THEN d.attempts+1 ELSE 1 END,
            content=CASE WHEN d.source_hash=excluded.source_hash THEN d.content END,
            published_at=CASE WHEN d.source_hash=excluded.source_hash THEN d.published_at END,
            lease_id=excluded.lease_id, due_at=excluded.due_at, failure_code=NULL`, [row.id, row.source_hash, lease]);
        return { id: row.id, skillId: row.skill_id, version: row.version, sourceHash: row.source_hash, lease };
      });
    },
    async finishRecommendedDetail(job, { content, failureCode }) {
      return tx(async (client) => {
        await client.query('SELECT id FROM catalogue_recommendations WHERE id FOR UPDATE');
        const [current] = await currentSources(client.query.bind(client), job.skillId);
        if (current?.id !== job.id || current.source_hash !== job.sourceHash) return false;
        const result = await client.query(`UPDATE recommended_skill_details SET lease_id=NULL,
          status=CASE WHEN $4::jsonb IS NOT NULL THEN 'ready' WHEN attempts >= $6 THEN 'failed' ELSE 'queued' END,
          content=COALESCE($4::jsonb,content), revision=revision+CASE WHEN $4::jsonb IS NULL THEN 0 ELSE 1 END,
          published_at=CASE WHEN $4::jsonb IS NULL THEN published_at ELSE now() END,
          failure_code=$5, due_at=now()+attempts*interval '1 minute'
          WHERE package_version_id=$1 AND source_hash=$2 AND lease_id=$3 AND due_at > now()`,
        [job.id, job.sourceHash, job.lease, content ?? null, failureCode ?? null, attemptLimit]);
        return result.rowCount === 1;
      });
    },
    async getRecommendedDetail({ skillId, version }) {
      const [current] = await currentSources(query, skillId, true);
      if (current?.version !== version || !current.published_content) return null;
      return publicPresentation({ ...current, content_hash: current.source_hash, published_origin: 'recommended_generated' });
    }
  };
}
