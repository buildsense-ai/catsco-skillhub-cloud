import fs from "node:fs/promises";
import path from "node:path";
import { generateId, JobStatus, nowIso, sha256, ValidationError } from "../domain/index.js";
import { createPresentationStore, ensurePresentationSchema } from "../presentations/store.js";
import { createPresentationAssetStore } from "../presentations/asset-store.js";
import { createPublicationTaskStore } from "../publication-tasks/store.js";
import { createPublicationCommitStore, lockPublicationCompletion, finishPublicationCompletion } from '../publication-tasks/commit-store.js';
import { createPublicVersionStore, adoptPublicVersion, comparePublicVersions } from "../publication-tasks/versions.js";

let poolByUrl = new Map();

export async function ensureRuntimeDirectories(config) {
  const dirs = [
    config.storageRoot,
    config.logsRoot,
    config.sharedRoot,
    config.paths.intake,
    config.paths.packages,
    config.paths.artifacts,
    config.paths.reviews,
    config.paths.tmp,
    config.paths.private,
    config.paths.privateArtifacts,
    config.paths.gitPublic,
    config.paths.gitPrivate,
    config.paths.keys
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

export async function getPool(config) {
  if (!config.databaseUrl) {
    throw new Error("SKILLHUB_DATABASE_URL is required for production PostgreSQL storage");
  }
  if (poolByUrl.has(config.databaseUrl)) return poolByUrl.get(config.databaseUrl);
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  poolByUrl.set(config.databaseUrl, pool);
  return pool;
}

export async function closePools() {
  const pools = [...poolByUrl.values()];
  poolByUrl = new Map();
  await Promise.all(pools.map((pool) => pool.end()));
}

export function createStore(config) {
  let simplifiedSchemaReady = false;
  let simplifiedSchemaPromise = null;

  async function query(text, params = []) {
    const pool = await getPool(config);
    return pool.query(text, params);
  }

  async function tx(fn) {
    const pool = await getPool(config);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureSimplifiedSchema() {
    if (simplifiedSchemaReady) return;
    if (simplifiedSchemaPromise) return simplifiedSchemaPromise;
    simplifiedSchemaPromise = (async () => {
      const result = await query(`
        SELECT
          to_regclass('public.publisher_profiles') IS NOT NULL AS publisher_profiles,
          to_regclass('public.skill_scans') IS NOT NULL AS skill_scans,
          to_regclass('public.skill_versions') IS NOT NULL AS skill_versions,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'publisher_profiles'
              AND column_name = 'catsco_uid'
          ) AS catsco_identity_column,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'skill_versions'
              AND column_name = 'git_commit_sha'
          ) AS git_columns,
          to_regclass('public.skill_visibility_grants') IS NOT NULL AS skill_visibility_grants,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'skills'
              AND column_name = 'visibility_scope'
          ) AS skill_visibility_columns
      `);
      const schema = result.rows[0] || {};
      if (
        !schema.publisher_profiles
        || !schema.skill_scans
        || !schema.skill_versions
        || !schema.catsco_identity_column
        || !schema.git_columns
        || !schema.skill_visibility_grants
        || !schema.skill_visibility_columns
      ) {
        throw new Error("SkillHub database schema is incomplete; run npm run db:migrate (including migration 010_skill_visibility)");
      }
      simplifiedSchemaReady = true;
    })().catch((error) => {
      simplifiedSchemaPromise = null;
      throw error;
    });
    return simplifiedSchemaPromise;
  }

  return {
    query,
    tx,
    ...createPresentationStore({ query, tx }),
    ...createPresentationAssetStore({ query, tx }),
    ...createPublicationTaskStore({ query, tx }),
    ...createPublicationCommitStore({ query, tx, config }),
    ...createPublicVersionStore({ tx }),
    async listCatalogueVersions({ viewerUserId = null, viewerCatsCoUid = null, includeAll = false } = {}) {
      await ensureSimplifiedSchema();
      await ensurePresentationSchema(query);
      const result = await query(`SELECT v.*, publisher_profiles.display_name AS publisher_display_name,
          publisher_profiles.contact AS publisher_contact,
          s.visibility_scope, s.visibility_revision, s.visibility_updated_at,
          p.published_revision AS presentation_revision,
          p.published_content->>'summary' AS presentation_summary,
          p.published_content->>'primaryCategory' AS presentation_category
        FROM skill_versions v
        LEFT JOIN publisher_profiles ON publisher_profiles.user_id = v.owner_user_id
        LEFT JOIN skills s ON s.id = v.skill_id
        LEFT JOIN skill_visibility_grants g ON g.skill_id = s.id AND g.catsco_uid = $2
        LEFT JOIN skill_presentations p ON p.package_version_id = v.id
        WHERE v.status = 'published' AND v.yanked_at IS NULL
          AND ($3::boolean OR COALESCE(s.visibility_scope, 'public') = 'public'
            OR ($1::text IS NOT NULL AND COALESCE(s.owner_user_id, v.owner_user_id) = $1)
            OR ($2::text IS NOT NULL AND COALESCE(s.visibility_scope, 'public') = 'shared' AND g.catsco_uid IS NOT NULL))
        ORDER BY v.published_at DESC`, [viewerUserId, viewerCatsCoUid, includeAll]);
      return result.rows.map((row) => ({
        ...mapPackageVersion(row),
        ...(row.presentation_revision ? { presentationSummary: {
          revision: row.presentation_revision,
          summary: row.presentation_summary,
          primaryCategory: row.presentation_category
        } } : {})
      }));
    },
    async healthStats() {
      await ensureSimplifiedSchema();
      const result = await query(`
        SELECT
          (SELECT count(*)::int FROM skill_versions) AS submissions,
          (SELECT count(*)::int FROM skill_versions WHERE status = 'published' AND yanked_at IS NULL) AS packages,
          (SELECT count(*)::int FROM users) AS users
      `);
      return result.rows[0];
    },

    async createUser({ email, passwordHash, displayName }) {
      const id = generateId("user");
      const normalizedEmail = normalizeEmail(email);
      return tx(async (client) => {
        const result = await client.query(
          `INSERT INTO users (id, email, password_hash, display_name)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [id, normalizedEmail, passwordHash, displayName]
        );
        await client.query(
          `INSERT INTO user_roles (id, user_id, role, granted_by)
           VALUES ($1, $2, 'user', 'system')`,
          [generateId("role"), id]
        );
        return mapUser(result.rows[0]);
      });
    },

    async getUserByEmail(email) {
      const result = await query(`SELECT * FROM users WHERE email = $1`, [normalizeEmail(email)]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async getUserById(userId) {
      const result = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async listUsers() {
      const result = await query(`
        SELECT u.*,
          COALESCE(json_agg(ur.role) FILTER (WHERE ur.revoked_at IS NULL), '[]') AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `);
      return result.rows.map((row) => ({ ...mapUser(row), roles: row.roles ?? [] }));
    },

    async getRoles(userId) {
      const result = await query(
        `SELECT role FROM user_roles
         WHERE user_id = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY role`,
        [userId]
      );
      return result.rows.map((row) => row.role);
    },

    async grantRole({ userId, role, grantedBy }) {
      const id = generateId("role");
      await query(
        `INSERT INTO user_roles (id, user_id, role, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING`,
        [id, userId, role, grantedBy]
      );
    },

    async revokeRole({ userId, role }) {
      await query(
        `UPDATE user_roles
         SET revoked_at = now()
         WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`,
        [userId, role]
      );
    },

    async countActiveRole(role) {
      const result = await query(
        `SELECT count(*)::int AS count
         FROM user_roles
         WHERE role = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`,
        [role]
      );
      return result.rows[0]?.count ?? 0;
    },

    async createSession({ userId, tokenHash, expiresAt, ipHash, userAgent }) {
      const id = generateId("sess");
      const result = await query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_hash, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, userId, tokenHash, expiresAt, ipHash, userAgent]
      );
      return mapSession(result.rows[0]);
    },

    async getSessionByTokenHash(tokenHash) {
      const result = await query(
        `SELECT s.*, u.email, u.display_name, u.status AS user_status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
           AND u.status = 'active'`,
        [tokenHash]
      );
      if (!result.rows[0]) return null;
      await query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [result.rows[0].id]);
      return mapSession(result.rows[0]);
    },

    async revokeSession(tokenHash) {
      await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
    },

    async getDeveloperProfile(userId) {
      await ensureSimplifiedSchema();
      const result = await query(`SELECT * FROM publisher_profiles WHERE user_id = $1`, [userId]);
      return result.rows[0] ? mapDeveloperProfile(result.rows[0]) : null;
    },

    async getDeveloperProfileByNamespace(namespace) {
      await ensureSimplifiedSchema();
      const result = await query(`SELECT * FROM publisher_profiles WHERE namespace = $1`, [String(namespace ?? "").trim()]);
      return result.rows[0] ? mapDeveloperProfile(result.rows[0]) : null;
    },

    async getDeveloperProfileByCatsCoUid(catsCoUid) {
      await ensureSimplifiedSchema();
      const uid = String(catsCoUid ?? "").trim();
      if (!uid) return null;
      const result = await query(`SELECT * FROM publisher_profiles WHERE catsco_uid = $1`, [uid]);
      return result.rows[0] ? mapDeveloperProfile(result.rows[0]) : null;
    },

    async claimCatsCoPublisherIdentity({
      catsCoUid,
      namespace,
      displayName,
      contact,
      internalEmail,
      passwordHash
    }) {
      await ensureSimplifiedSchema();
      const uid = String(catsCoUid ?? "").trim();
      const normalizedNamespace = String(namespace ?? "").trim();
      if (!uid || !normalizedNamespace) {
        throw new ValidationError(
          "CatsCo publisher identity is incomplete.",
          "catsco.publisher_identity_incomplete",
          400
        );
      }
      return tx(async (client) => {
        const lockKeys = [
          `catsco-publisher-uid:${uid}`,
          `catsco-publisher-namespace:${normalizedNamespace}`
        ].sort();
        for (const lockKey of lockKeys) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [lockKey]);
        }

        const identityResult = await client.query(
          `SELECT * FROM publisher_profiles WHERE catsco_uid = $1 FOR UPDATE`,
          [uid]
        );
        let profileRow = identityResult.rows[0] || null;
        let userRow = null;
        if (profileRow) {
          const userResult = await client.query(
            `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
            [profileRow.user_id]
          );
          userRow = userResult.rows[0] || null;
          if (!userRow) {
            throw new ValidationError(
              "CatsCo publisher identity is inconsistent.",
              "catsco.publisher_identity_inconsistent",
              409
            );
          }
        }

        const namespaceResult = await client.query(
          `SELECT * FROM publisher_profiles WHERE namespace = $1 FOR UPDATE`,
          [normalizedNamespace]
        );
        const namespaceRow = namespaceResult.rows[0] || null;
        if (namespaceRow && (!profileRow || namespaceRow.user_id !== profileRow.user_id)) {
          throw new ValidationError(
            "CatsCo publisher namespace is already linked to another account.",
            "catsco.publisher_namespace_conflict",
            409
          );
        }

        if (!profileRow) {
          const userId = generateId("user");
          const userResult = await client.query(
            `INSERT INTO users (id, email, password_hash, display_name)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [userId, normalizeEmail(internalEmail), passwordHash, displayName]
          );
          userRow = userResult.rows[0];
          await client.query(
            `INSERT INTO user_roles (id, user_id, role, granted_by)
             VALUES ($1, $2, 'user', 'catsco')`,
            [generateId("role"), userId]
          );
          const profileResult = await client.query(
            `INSERT INTO publisher_profiles (
               id, user_id, namespace, display_name, contact, website_url, catsco_uid, status
             )
             VALUES ($1, $2, $3, $4, $5, '', $6, 'active')
             RETURNING *`,
            [generateId("pub"), userId, normalizedNamespace, displayName, contact, uid]
          );
          profileRow = profileResult.rows[0];
        } else {
          const userResult = await client.query(
            `UPDATE users
             SET display_name = $2, updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [profileRow.user_id, displayName]
          );
          userRow = userResult.rows[0];
          const profileResult = await client.query(
            `UPDATE publisher_profiles
             SET namespace = $2,
                 display_name = $3,
                 contact = $4,
                 updated_at = now()
             WHERE user_id = $1
             RETURNING *`,
            [profileRow.user_id, normalizedNamespace, displayName, contact]
          );
          profileRow = profileResult.rows[0];
        }

        return {
          user: mapUser(userRow),
          developerProfile: mapDeveloperProfile(profileRow)
        };
      });
    },

    async ensureDeveloperProfile({
      userId,
      namespace,
      displayName,
      contact,
      websiteUrl = "",
      approvedBy = "system",
      catsCoUid = null
    }) {
      await ensureSimplifiedSchema();
      const normalizedCatsCoUid = String(catsCoUid ?? "").trim() || null;
      const result = await query(
        `INSERT INTO publisher_profiles (id, user_id, namespace, display_name, contact, website_url, catsco_uid, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         ON CONFLICT (user_id) DO UPDATE SET
           namespace = EXCLUDED.namespace,
           display_name = EXCLUDED.display_name,
           contact = EXCLUDED.contact,
           website_url = EXCLUDED.website_url,
           catsco_uid = COALESCE(EXCLUDED.catsco_uid, publisher_profiles.catsco_uid),
           updated_at = now()
         RETURNING *`,
        [generateId("pub"), userId, namespace, displayName, contact, websiteUrl, normalizedCatsCoUid]
      );
      return result.rows[0] ? mapDeveloperProfile(result.rows[0]) : null;
    },

    async createDeveloperApplication({ userId, namespace, displayName, contact, websiteUrl, reason }) {
      const id = generateId("devapp");
      const result = await query(
        `INSERT INTO developer_applications (id, user_id, namespace, display_name, contact, website_url, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, userId, namespace, displayName, contact, websiteUrl, reason]
      );
      return mapDeveloperApplication(result.rows[0]);
    },

    async getDeveloperApplicationForUser(userId) {
      const result = await query(
        `SELECT * FROM developer_applications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      );
      return result.rows[0] ? mapDeveloperApplication(result.rows[0]) : null;
    },

    async listDeveloperApplications(status = "") {
      const result = await query(
        `SELECT da.*, u.email
         FROM developer_applications da
         JOIN users u ON u.id = da.user_id
         WHERE ($1 = '' OR da.status = $1)
         ORDER BY da.created_at DESC`,
        [status]
      );
      return result.rows.map((row) => ({ ...mapDeveloperApplication(row), email: row.email }));
    },

    async approveDeveloperApplication({ applicationId, reviewerId, comment }) {
      return tx(async (client) => {
        const appResult = await client.query(
          `UPDATE developer_applications
           SET status = 'approved', reviewed_by = $2, review_comment = $3, reviewed_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [applicationId, reviewerId, comment]
        );
        const application = appResult.rows[0];
        if (!application) return null;
        await client.query(
          `INSERT INTO developer_profiles (id, user_id, namespace, display_name, contact, website_url, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (user_id) DO UPDATE SET
             namespace = EXCLUDED.namespace,
             display_name = EXCLUDED.display_name,
             contact = EXCLUDED.contact,
             website_url = EXCLUDED.website_url,
             status = 'approved',
             approved_by = EXCLUDED.approved_by,
             approved_at = now(),
             updated_at = now()`,
          [generateId("devprof"), application.user_id, application.namespace, application.display_name, application.contact, application.website_url, reviewerId]
        );
        await client.query(
          `INSERT INTO user_roles (id, user_id, role, granted_by)
           VALUES ($1, $2, 'developer', $3)
           ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING`,
          [generateId("role"), application.user_id, reviewerId]
        );
        return mapDeveloperApplication(application);
      });
    },

    async rejectDeveloperApplication({ applicationId, reviewerId, comment }) {
      const result = await query(
        `UPDATE developer_applications
         SET status = 'rejected', reviewed_by = $2, review_comment = $3, reviewed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [applicationId, reviewerId, comment]
      );
      return result.rows[0] ? mapDeveloperApplication(result.rows[0]) : null;
    },

    async createSubmission(submission) {
      const result = await query(
        `INSERT INTO skill_submissions
          (id, submitter_id, submitter_name, status, normalized_manifest, upload_sha256, upload_summary, notes, risk_level, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          submission.id,
          submission.submitterId,
          submission.submitterName,
          submission.status,
          toJsonParam(submission.normalizedManifest),
          submission.uploadSha256,
          toJsonParam(submission.uploadSummary),
          submission.notes,
          submission.riskLevel,
          submission.createdAt,
          submission.updatedAt
        ]
      );
      return mapSubmission(result.rows[0]);
    },

    async getSubmission(submissionId) {
      const result = await query(`SELECT * FROM skill_submissions WHERE id = $1`, [submissionId]);
      return result.rows[0] ? mapSubmission(result.rows[0]) : null;
    },

    async listSubmissionsForDeveloper(userId) {
      const result = await query(`SELECT * FROM skill_submissions WHERE submitter_id = $1 ORDER BY created_at DESC`, [userId]);
      return result.rows.map(mapSubmission);
    },

    async listReviewSubmissions(status = "") {
      const result = await query(
        `SELECT s.*, sr.id AS scan_id, sr.status AS scan_status, sr.risk_level AS scan_risk_level,
                sr.summary AS scan_summary_full, sr.findings, sr.inventory, sr.scanner_version,
                sr.started_at, sr.finished_at
         FROM skill_submissions s
         LEFT JOIN scan_runs sr ON sr.id = s.latest_scan_run_id
         WHERE ($1 = '' OR s.status = $1)
         ORDER BY s.created_at DESC`,
        [status]
      );
      return result.rows.map((row) => ({
        ...mapSubmission(row),
        scanRun: row.scan_id
          ? {
              id: row.scan_id,
              submissionId: row.id,
              status: row.scan_status,
              riskLevel: row.scan_risk_level,
              summary: row.scan_summary_full,
              findings: row.findings,
              inventory: row.inventory,
              scannerVersion: row.scanner_version,
              startedAt: row.started_at?.toISOString?.() ?? row.started_at,
              finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at
            }
          : null
      }));
    },

    async updateSubmissionStatus(submissionId, status) {
      const result = await query(
        `UPDATE skill_submissions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [submissionId, status]
      );
      return result.rows[0] ? mapSubmission(result.rows[0]) : null;
    },

    async updateSubmissionManifest(submissionId, manifest) {
      const result = await query(
        `UPDATE skill_submissions
         SET normalized_manifest = $2, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [submissionId, toJsonParam(manifest)]
      );
      return result.rows[0] ? mapSubmission(result.rows[0]) : null;
    },

    async saveScanRun(scanRun) {
      await query(
        `INSERT INTO scan_runs
          (id, submission_id, status, risk_level, summary, findings, inventory, scanner_version, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          scanRun.id,
          scanRun.submissionId,
          scanRun.status,
          scanRun.riskLevel,
          toJsonParam(scanRun.summary),
          toJsonParam(scanRun.findings),
          toJsonParam(scanRun.inventory),
          scanRun.scannerVersion,
          scanRun.startedAt,
          scanRun.finishedAt
        ]
      );
      await query(
        `UPDATE skill_submissions
         SET latest_scan_run_id = $2, scan_summary = $3, risk_level = $4, status = $5, updated_at = now()
         WHERE id = $1`,
        [scanRun.submissionId, scanRun.id, toJsonParam(scanRun.summary), scanRun.riskLevel, scanRun.nextSubmissionStatus]
      );
    },

    async getScanRun(scanRunId) {
      if (!scanRunId) return null;
      const result = await query(`SELECT * FROM scan_runs WHERE id = $1`, [scanRunId]);
      return result.rows[0] ? mapScanRun(result.rows[0]) : null;
    },

    async saveSkillScan(scanRun) {
      await ensureSimplifiedSchema();
      await query(
        `INSERT INTO skill_scans
          (id, skill_id, version, upload_id, status, risk_level, summary, findings, inventory, scanner_version, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          scanRun.id,
          scanRun.skillId,
          scanRun.version,
          scanRun.uploadId,
          scanRun.status,
          scanRun.riskLevel,
          toJsonParam(scanRun.summary),
          toJsonParam(scanRun.findings),
          toJsonParam(scanRun.inventory),
          scanRun.scannerVersion,
          scanRun.startedAt,
          scanRun.finishedAt
        ]
      );
    },

    async getSkillScan(scanRunId) {
      if (!scanRunId) return null;
      await ensureSimplifiedSchema();
      const result = await query(`SELECT * FROM skill_scans WHERE id = $1`, [scanRunId]);
      return result.rows[0] ? mapSkillScan(result.rows[0]) : null;
    },

    async addReview({ submissionId, reviewerId, action, comment }) {
      await query(
        `INSERT INTO reviews (id, submission_id, reviewer_id, action, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [generateId("review"), submissionId, reviewerId, action, comment]
      );
    },

    async approveSubmission({ submissionId, reviewerId, comment }) {
      return tx(async (client) => {
        const sub = await client.query(`SELECT * FROM skill_submissions WHERE id = $1 FOR UPDATE`, [submissionId]);
        if (!sub.rows[0]) return null;
        await client.query(
          `UPDATE skill_submissions SET status = 'approved', updated_at = now() WHERE id = $1`,
          [submissionId]
        );
        await client.query(
          `INSERT INTO reviews (id, submission_id, reviewer_id, action, comment)
           VALUES ($1, $2, $3, 'approve', $4)`,
          [generateId("review"), submissionId, reviewerId, comment]
        );
        return mapSubmission({ ...sub.rows[0], status: "approved" });
      });
    },

    async markSubmissionReviewDecision({ submissionId, reviewerId, action, status, comment }) {
      return tx(async (client) => {
        const result = await client.query(
          `UPDATE skill_submissions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [submissionId, status]
        );
        if (!result.rows[0]) return null;
        await client.query(
          `INSERT INTO reviews (id, submission_id, reviewer_id, action, comment)
           VALUES ($1, $2, $3, $4, $5)`,
          [generateId("review"), submissionId, reviewerId, action, comment]
        );
        return mapSubmission(result.rows[0]);
      });
    },

    async enqueueJob(type, payload = {}, options = {}) {
      const id = generateId("job");
      const result = await query(
        `INSERT INTO jobs (id, type, payload, status, max_attempts, run_after)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, type, toJsonParam(payload), JobStatus.QUEUED, options.maxAttempts ?? 3, options.runAfter ?? nowIso()]
      );
      return mapJob(result.rows[0]);
    },

    async claimNextJob(workerId) {
      return tx(async (client) => {
        const result = await client.query(
          `SELECT * FROM jobs
           WHERE status = $1
             AND run_after <= now()
             AND attempts < max_attempts
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
          [JobStatus.QUEUED]
        );
        const job = result.rows[0];
        if (!job) return null;
        const updated = await client.query(
          `UPDATE jobs
           SET status = $2, locked_by = $3, locked_at = now(), attempts = attempts + 1, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [job.id, JobStatus.RUNNING, workerId]
        );
        return mapJob(updated.rows[0]);
      });
    },

    async completeJob(jobId) {
      await query(`UPDATE jobs SET status = $2, updated_at = now() WHERE id = $1`, [jobId, JobStatus.SUCCEEDED]);
    },

    async failJob(jobId, error, retry = true) {
      const message = sanitizeError(error);
      await query(
        `UPDATE jobs
         SET status = CASE WHEN $3 = true AND attempts < max_attempts THEN $4 ELSE $5 END,
             last_error = $2,
             locked_by = NULL,
             locked_at = NULL,
             run_after = now() + ((LEAST(60, attempts * attempts))::text || ' seconds')::interval,
             updated_at = now()
         WHERE id = $1`,
        [jobId, message, retry, JobStatus.QUEUED, JobStatus.FAILED]
      );
    },

    async findPackageBySkillVersion(skillId, version) {
      await ensureSimplifiedSchema();
      const result = await query(`SELECT * FROM skill_versions WHERE skill_id = $1 AND version = $2`, [skillId, version]);
      return result.rows[0] ? mapPackageVersion(result.rows[0]) : null;
    },

    async findPackageVersionWithOwner(packageVersionId) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT *
         FROM skill_versions
         WHERE id = $1`,
        [packageVersionId]
      );
      return result.rows[0] ? mapPackageVersion(result.rows[0]) : null;
    },

    async findPackageBySkillContentHash(skillId, contentHash) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT * FROM skill_versions
         WHERE skill_id = $1 AND content_hash = $2 AND status = 'published' AND yanked_at IS NULL
         ORDER BY published_at DESC
         LIMIT 1`,
        [skillId, contentHash]
      );
      return result.rows[0] ? mapPackageVersion(result.rows[0]) : null;
    },

    async createPackageVersion(packageVersion, submission, { publicationTask } = {}) {
      await ensureSimplifiedSchema();
      return tx(async (client) => {
        const completion = publicationTask ? await lockPublicationCompletion(client,publicationTask,packageVersion,submission) : null;
        const taskUpload = await client.query("SELECT task_id FROM publication_commits WHERE identity->>'uploadId'=$1",[submission.id]);
        if (taskUpload.rowCount && taskUpload.rows[0].task_id !== completion?.id) {
          throw new ValidationError('Task publication requires atomic completion.', 'skillhub.publication_version_conflict', 409);
        }
        await adoptPublicVersion(client, { uploadId: submission.id, skillId: packageVersion.skillId,
          ownerId: submission.submitterId, version: packageVersion.version });
        const previous = (await client.query('SELECT * FROM skill_versions WHERE skill_id=$1 AND version=$2',
          [packageVersion.skillId, packageVersion.version])).rows[0];
        if (previous) {
          if (previous.upload_id !== submission.id || previous.checksum_sha256 !== packageVersion.checksumSha256) {
            throw new ValidationError('Publication version already has different content.', 'skillhub.publication_version_conflict', 409);
          }
          if (completion) await finishPublicationCompletion(client,completion,packageVersion,config.publicationTasks.retentionMs);
          return mapPackageVersion(previous);
        }
        const current = (await client.query('SELECT latest_version FROM skills WHERE id=$1', [packageVersion.skillId])).rows[0];
        const latestVersion = current?.latest_version && comparePublicVersions(current.latest_version, packageVersion.version) > 0
          ? current.latest_version : packageVersion.version;
        await client.query(
          `INSERT INTO skills (id, name, display_name, owner_user_id, latest_version, status)
           VALUES ($1, $2, $3, $4, $5, 'published')
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             display_name = EXCLUDED.display_name,
             latest_version = EXCLUDED.latest_version,
             status = 'published',
             updated_at = now()`,
          [packageVersion.skillId, packageVersion.skillName, packageVersion.displayName, submission.submitterId, latestVersion]
        );
        await client.query(
          `INSERT INTO skill_versions
            (id, skill_id, skill_name, display_name, version, status, package_path, package_file, package_url,
             package_size, checksum_sha256, payload_sha256, content_hash, signature, manifest, owner_user_id, upload_id, scan_run_id,
             risk_level, scan_summary, findings, published_at, storage_backend, git_repository_id,
             git_commit_sha, git_tree_sha, git_tag, artifact_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [
            packageVersion.id,
            packageVersion.skillId,
            packageVersion.skillName,
            packageVersion.displayName,
            packageVersion.version,
            packageVersion.status,
            packageVersion.packagePath,
            packageVersion.packageFile,
            packageVersion.packageUrl,
            packageVersion.packageSize,
            packageVersion.checksumSha256,
            packageVersion.payloadSha256,
            packageVersion.contentHash ?? null,
            toJsonParam(packageVersion.signature),
            toJsonParam(packageVersion.manifest),
            submission.submitterId,
            packageVersion.submissionId,
            packageVersion.scanRunId,
            packageVersion.riskLevel ?? "low",
            toJsonParam(packageVersion.scanSummary ?? {}),
            toJsonParam(packageVersion.findings ?? []),
            packageVersion.publishedAt,
            packageVersion.storageBackend ?? "legacy-fs",
            packageVersion.gitRepositoryId ?? null,
            packageVersion.gitCommitSha ?? null,
            packageVersion.gitTreeSha ?? null,
            packageVersion.gitTag ?? null,
            packageVersion.artifactSha256 ?? null
          ]
        );
        if (completion) await finishPublicationCompletion(client,completion,packageVersion,config.publicationTasks.retentionMs);
        return packageVersion;
      });
    },

    async listPublishedVersions({ viewerUserId = null, viewerCatsCoUid = null, includeAll = false } = {}) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT skill_versions.*,
                publisher_profiles.display_name AS publisher_display_name,
                publisher_profiles.contact AS publisher_contact,
                s.visibility_scope, s.visibility_revision, s.visibility_updated_at
         FROM skill_versions
         LEFT JOIN publisher_profiles ON publisher_profiles.user_id = skill_versions.owner_user_id
         LEFT JOIN skills s ON s.id = skill_versions.skill_id
         LEFT JOIN skill_visibility_grants g ON g.skill_id = s.id AND g.catsco_uid = $2
         WHERE skill_versions.status = 'published' AND skill_versions.yanked_at IS NULL
           AND ($3::boolean OR COALESCE(s.visibility_scope, 'public') = 'public'
             OR ($1::text IS NOT NULL AND COALESCE(s.owner_user_id, skill_versions.owner_user_id) = $1)
             OR ($2::text IS NOT NULL AND COALESCE(s.visibility_scope, 'public') = 'shared' AND g.catsco_uid IS NOT NULL))
         ORDER BY skill_versions.published_at DESC`,
        [viewerUserId, viewerCatsCoUid, includeAll]
      );
      return result.rows.map(mapPackageVersion);
    },

    async findPublishedVersion(skillId, version, { viewerUserId = null, viewerCatsCoUid = null, includeAll = false } = {}) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT skill_versions.*,
                publisher_profiles.display_name AS publisher_display_name,
                publisher_profiles.contact AS publisher_contact,
                s.visibility_scope, s.visibility_revision, s.visibility_updated_at
         FROM skill_versions
         LEFT JOIN publisher_profiles ON publisher_profiles.user_id = skill_versions.owner_user_id
         LEFT JOIN skills s ON s.id = skill_versions.skill_id
         LEFT JOIN skill_visibility_grants g ON g.skill_id = s.id AND g.catsco_uid = $3
         WHERE skill_versions.skill_id = $1 AND skill_versions.version = $2
           AND skill_versions.status = 'published' AND skill_versions.yanked_at IS NULL
           AND ($4::boolean OR COALESCE(s.visibility_scope, 'public') = 'public'
             OR ($5::text IS NOT NULL AND COALESCE(s.owner_user_id, skill_versions.owner_user_id) = $5)
             OR ($3::text IS NOT NULL AND COALESCE(s.visibility_scope, 'public') = 'shared' AND g.catsco_uid IS NOT NULL) )`,
        [skillId, version, viewerCatsCoUid, includeAll, viewerUserId]
      );
      return result.rows[0] ? mapPackageVersion(result.rows[0]) : null;
    },

    async findPublishedVersionByPackagePath(packagePath, {
      artifactSha256 = null,
      viewerUserId = null,
      viewerCatsCoUid = null,
      includeAll = false
    } = {}) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT skill_versions.*,
                publisher_profiles.display_name AS publisher_display_name,
                publisher_profiles.contact AS publisher_contact,
                s.visibility_scope, s.visibility_revision, s.visibility_updated_at
         FROM skill_versions
         LEFT JOIN publisher_profiles ON publisher_profiles.user_id = skill_versions.owner_user_id
         LEFT JOIN skills s ON s.id = skill_versions.skill_id
         LEFT JOIN skill_visibility_grants g ON g.skill_id = s.id AND g.catsco_uid = $3
         WHERE (skill_versions.package_path = $1
                OR ($2::text IS NOT NULL AND skill_versions.artifact_sha256 = $2))
           AND skill_versions.status = 'published' AND skill_versions.yanked_at IS NULL
           AND ($4::boolean OR COALESCE(s.visibility_scope, 'public') = 'public'
             OR ($5::text IS NOT NULL AND COALESCE(s.owner_user_id, skill_versions.owner_user_id) = $5)
             OR ($3::text IS NOT NULL AND COALESCE(s.visibility_scope, 'public') = 'shared' AND g.catsco_uid IS NOT NULL))
         ORDER BY skill_versions.published_at DESC
         LIMIT 1`,
        [packagePath, artifactSha256, viewerCatsCoUid, includeAll, viewerUserId]
      );
      return result.rows[0] ? mapPackageVersion(result.rows[0]) : null;
    },

    async findRecoverablePublishedVersion(skillId, version) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT * FROM skill_versions
         WHERE skill_id = $1 AND version = $2 AND status IN ('published', 'yanked')`,
        [skillId, version]
      );
      return result.rows[0] ? mapPackageVersion(result.rows[0]) : null;
    },

    async listPublishedVersionsForSkill(skillId, { viewerUserId = null, viewerCatsCoUid = null, includeAll = false } = {}) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT skill_versions.*,
                publisher_profiles.display_name AS publisher_display_name,
                publisher_profiles.contact AS publisher_contact,
                s.visibility_scope, s.visibility_revision, s.visibility_updated_at
         FROM skill_versions
         LEFT JOIN publisher_profiles ON publisher_profiles.user_id = skill_versions.owner_user_id
         LEFT JOIN skills s ON s.id = skill_versions.skill_id
         LEFT JOIN skill_visibility_grants g ON g.skill_id = s.id AND g.catsco_uid = $2
         WHERE skill_versions.skill_id = $1
           AND skill_versions.status = 'published' AND skill_versions.yanked_at IS NULL
           AND ($3::boolean OR COALESCE(s.visibility_scope, 'public') = 'public'
             OR ($4::text IS NOT NULL AND COALESCE(s.owner_user_id, skill_versions.owner_user_id) = $4)
             OR ($2::text IS NOT NULL AND COALESCE(s.visibility_scope, 'public') = 'shared' AND g.catsco_uid IS NOT NULL))
         ORDER BY skill_versions.published_at DESC`,
        [skillId, viewerCatsCoUid, includeAll, viewerUserId]
      );
      return result.rows.map(mapPackageVersion);
    },

    async listPackageVersionsForSkill(skillId) {
      await ensureSimplifiedSchema();
      const result = await query(
        `SELECT skill_versions.*, s.visibility_scope, s.visibility_revision, s.visibility_updated_at
         FROM skill_versions
         LEFT JOIN skills s ON s.id = skill_versions.skill_id
         WHERE skill_versions.skill_id = $1
         ORDER BY skill_versions.published_at DESC NULLS LAST, skill_versions.created_at DESC`,
        [skillId]
      );
      return result.rows.map(mapPackageVersion);
    },

    async listPackageVersionsForOwner(ownerUserId, { limit = 100 } = {}) {
      await ensureSimplifiedSchema();
      const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
      const result = await query(
        `SELECT skill_versions.*, s.visibility_scope, s.visibility_revision, s.visibility_updated_at
         FROM skill_versions
         LEFT JOIN skills s ON s.id = skill_versions.skill_id
         WHERE skill_versions.owner_user_id = $1
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT $2`,
        [ownerUserId, cappedLimit]
      );
      return result.rows.map(mapPackageVersion);
    },

    async getSkillVisibility(skillId) {
      await ensureSimplifiedSchema();
      const skill = await query(
        `SELECT id, owner_user_id, visibility_scope, visibility_revision, visibility_updated_at
         FROM skills WHERE id = $1`,
        [skillId]
      );
      if (!skill.rows[0]) return null;
      const grants = await query(
        `SELECT catsco_uid, created_at
         FROM skill_visibility_grants
         WHERE skill_id = $1
         ORDER BY created_at, catsco_uid`,
        [skillId]
      );
      const row = skill.rows[0];
      return {
        skillId: row.id,
        ownerUserId: row.owner_user_id,
        visibilityScope: row.visibility_scope || "public",
        visibilityRevision: Number(row.visibility_revision || 1),
        visibilityUpdatedAt: iso(row.visibility_updated_at),
        sharedUserUids: grants.rows.map((grant) => grant.catsco_uid)
      };
    },

    async updateSkillVisibility({
      skillId,
      actorUserId,
      isAdmin = false,
      visibilityScope,
      sharedUserUids = [],
      expectedRevision
    }) {
      await ensureSimplifiedSchema();
      const normalizedScope = String(visibilityScope ?? "").trim().toLowerCase();
      if (!["public", "shared", "private"].includes(normalizedScope)) {
        throw new ValidationError("visibilityScope 必须是 public、shared 或 private", "skill.visibility_scope_invalid");
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new ValidationError("expectedRevision 必须是正整数", "skill.visibility_revision_invalid");
      }
      const normalizedUids = [...new Set((Array.isArray(sharedUserUids) ? sharedUserUids : [])
        .map((uid) => String(uid ?? "").trim())
        .filter(Boolean))];
      if (normalizedUids.length > 200 || normalizedUids.some((uid) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(uid))) {
        throw new ValidationError("sharedUserUids 包含无效的 CatsCo UID", "skill.visibility_uid_invalid");
      }
      if (normalizedScope === "shared" && normalizedUids.length === 0) {
        throw new ValidationError("指定共享至少需要一个 CatsCo UID", "skill.visibility_grants_required");
      }
      return tx(async (client) => {
        const current = await client.query(
          `SELECT id, owner_user_id, visibility_revision
           FROM skills WHERE id = $1 FOR UPDATE`,
          [skillId]
        );
        const skill = current.rows[0];
        if (!skill) return null;
        if (!isAdmin && skill.owner_user_id !== actorUserId) {
          throw new ValidationError("只有 Skill Owner 或管理员可以修改可见范围", "skill.visibility_forbidden", 403);
        }
        if (Number(skill.visibility_revision || 1) !== expectedRevision) {
          throw new ValidationError("Skill 可见范围已被其他操作更新，请刷新后重试", "skill.visibility_conflict", 409);
        }
        const updated = await client.query(
          `UPDATE skills
           SET visibility_scope = $2,
               visibility_revision = visibility_revision + 1,
               visibility_updated_at = now(),
               updated_at = now()
           WHERE id = $1
           RETURNING id, owner_user_id, visibility_scope, visibility_revision, visibility_updated_at`,
          [skillId, normalizedScope]
        );
        await client.query(`DELETE FROM skill_visibility_grants WHERE skill_id = $1`, [skillId]);
        for (const uid of normalizedScope === "shared" ? normalizedUids : []) {
          await client.query(
            `INSERT INTO skill_visibility_grants (skill_id, catsco_uid, granted_by_user_id)
             VALUES ($1, $2, $3)`,
            [skillId, uid, actorUserId]
          );
        }
        const row = updated.rows[0];
        return {
          skillId: row.id,
          ownerUserId: row.owner_user_id,
          visibilityScope: row.visibility_scope,
          visibilityRevision: Number(row.visibility_revision),
          visibilityUpdatedAt: iso(row.visibility_updated_at),
          sharedUserUids: normalizedScope === "shared" ? normalizedUids : []
        };
      });
    },

    async listPackageVersionsForAdmin({ status = "", search = "", limit = 100 } = {}) {
      await ensureSimplifiedSchema();
      const normalizedStatus = String(status ?? "").trim();
      const normalizedSearch = String(search ?? "").trim().toLowerCase();
      const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
      const result = await query(
        `SELECT * FROM skill_versions
         WHERE ($1 = '' OR status = $1)
           AND (
             $2 = ''
             OR lower(skill_id) LIKE $3
             OR lower(skill_name) LIKE $3
             OR lower(display_name) LIKE $3
             OR lower(version) LIKE $3
           )
         ORDER BY created_at DESC
         LIMIT $4`,
        [normalizedStatus, normalizedSearch, `%${normalizedSearch}%`, cappedLimit]
      );
      return result.rows.map(mapPackageVersion);
    },

    async listAdminNamespaces({ search = "" } = {}) {
      await ensureSimplifiedSchema();
      const normalizedSearch = String(search ?? "").trim().toLowerCase();
      const result = await query(
        `SELECT
           split_part(id, '/', 1) AS namespace,
           count(*)::int AS skill_count,
           count(*) FILTER (WHERE status = 'published')::int AS published_skill_count,
           max(updated_at) AS updated_at
         FROM skills
         WHERE ($1 = '' OR lower(split_part(id, '/', 1)) LIKE $2)
         GROUP BY split_part(id, '/', 1)
         ORDER BY updated_at DESC NULLS LAST, namespace`,
        [normalizedSearch, `%${normalizedSearch}%`]
      );
      return result.rows.map((row) => ({
        namespace: row.namespace || "unknown",
        skillCount: Number(row.skill_count ?? 0),
        publishedSkillCount: Number(row.published_skill_count ?? 0),
        updatedAt: iso(row.updated_at)
      }));
    },

    async listAdminSkills({ namespace = "", search = "", status = "", limit = 500 } = {}) {
      await ensureSimplifiedSchema();
      const normalizedNamespace = String(namespace ?? "").trim().toLowerCase();
      const normalizedSearch = String(search ?? "").trim().toLowerCase();
      const normalizedStatus = String(status ?? "").trim();
      const cappedLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
      const result = await query(
        `SELECT
           s.*,
           count(v.id)::int AS version_count,
           count(v.id) FILTER (WHERE v.status = 'published' AND v.yanked_at IS NULL)::int AS published_version_count,
           max(v.published_at) AS last_published_at,
           coalesce(sum(v.download_count), 0)::int AS total_download_count,
           max(v.risk_level) FILTER (WHERE v.status = 'published' AND v.yanked_at IS NULL) AS latest_risk_level
         FROM skills s
         LEFT JOIN skill_versions v ON v.skill_id = s.id
         WHERE ($1 = '' OR lower(split_part(s.id, '/', 1)) = $1)
           AND ($2 = '' OR lower(s.id) LIKE $3 OR lower(s.name) LIKE $3 OR lower(s.display_name) LIKE $3)
           AND ($4 = '' OR s.status = $4)
         GROUP BY s.id
         ORDER BY s.updated_at DESC NULLS LAST, s.id
         LIMIT $5`,
        [normalizedNamespace, normalizedSearch, `%${normalizedSearch}%`, normalizedStatus, cappedLimit]
      );
      return result.rows.map(mapAdminSkill);
    },

    async yankPackageVersion(packageVersionId) {
      await ensureSimplifiedSchema();
      return tx(async (client) => {
        const result = await client.query(
          `UPDATE skill_versions
           SET status = 'yanked', yanked_at = now()
           WHERE id = $1 AND status = 'published' AND yanked_at IS NULL
           RETURNING *`,
          [packageVersionId]
        );
        const version = result.rows[0];
        if (!version) return null;

        const latest = await client.query(
          `SELECT version
           FROM skill_versions
           WHERE skill_id = $1 AND status = 'published' AND yanked_at IS NULL
           ORDER BY published_at DESC
           LIMIT 1`,
          [version.skill_id]
        );
        const latestVersion = latest.rows[0]?.version ?? null;
        await client.query(
          `UPDATE skills
           SET latest_version = $2,
               status = CASE WHEN $2::text IS NULL THEN 'yanked' ELSE 'published' END,
               updated_at = now()
           WHERE id = $1`,
          [version.skill_id, latestVersion]
        );

        return mapPackageVersion(version);
      });
    },

    async restorePackageVersion(packageVersionId) {
      await ensureSimplifiedSchema();
      return tx(async (client) => {
        const result = await client.query(
          `UPDATE skill_versions
           SET status = 'published', yanked_at = NULL, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [packageVersionId]
        );
        const version = result.rows[0];
        if (!version) return null;

        const latest = await client.query(
          `SELECT version
           FROM skill_versions
           WHERE skill_id = $1 AND status = 'published' AND yanked_at IS NULL
           ORDER BY published_at DESC
           LIMIT 1`,
          [version.skill_id]
        );
        const latestVersion = latest.rows[0]?.version ?? version.version;
        await client.query(
          `UPDATE skills
           SET latest_version = $2, status = 'published', updated_at = now()
           WHERE id = $1`,
          [version.skill_id, latestVersion]
        );

        return mapPackageVersion(version);
      });
    },

    async deletePackageVersion(packageVersionId) {
      await ensureSimplifiedSchema();
      return tx(async (client) => {
        const result = await client.query(
          `UPDATE skill_versions
           SET status = 'yanked', yanked_at = coalesce(yanked_at, now()), updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [packageVersionId]
        );
        const version = result.rows[0];
        if (!version) return null;
        const latest = await client.query(
          `SELECT version
           FROM skill_versions
           WHERE skill_id = $1 AND status = 'published' AND yanked_at IS NULL
           ORDER BY published_at DESC
           LIMIT 1`,
          [version.skill_id]
        );
        const latestVersion = latest.rows[0]?.version ?? null;
        await client.query(
          `UPDATE skills
           SET latest_version = $2,
               status = CASE WHEN $2::text IS NULL THEN 'yanked' ELSE 'published' END,
               updated_at = now()
           WHERE id = $1`,
          [version.skill_id, latestVersion]
        );
        return mapPackageVersion(version);
      });
    },

    async deleteSkill(skillId) {
      await ensureSimplifiedSchema();
      return tx(async (client) => {
        const versions = await client.query(
          `UPDATE skill_versions
           SET status = 'yanked', yanked_at = coalesce(yanked_at, now()), updated_at = now()
           WHERE skill_id = $1
           RETURNING *`,
          [skillId]
        );
        const skill = await client.query(
          `UPDATE skills
           SET latest_version = NULL, status = 'yanked', updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [skillId]
        );
        return { skill: skill.rows[0] ?? null, versions: versions.rows.map(mapPackageVersion) };
      });
    },

    async reservePrivateSkillMutation({ envelope, versionInput }) {
      return tx(async (client) => {
        const ownerLock = JSON.stringify([envelope.authority, envelope.ownerBotId]);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [ownerLock]);
        const existingMutation = await client.query(
          `SELECT * FROM private_skill_mutations
           WHERE authority = $1 AND owner_bot_id = $2 AND mutation_id = $3
           FOR UPDATE`,
          [envelope.authority, envelope.ownerBotId, envelope.mutationId]
        );
        if (existingMutation.rowCount) {
          const row = existingMutation.rows[0];
          if (row.request_fingerprint !== envelope.requestFingerprint) {
            throw new ValidationError(
              "MutationID was reused with different facts.",
              "MUTATION_IDEMPOTENCY_CONFLICT",
              409
            );
          }
          const versionResult = await client.query(
            `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
             FROM private_skill_versions v
             JOIN private_skills s ON s.id = v.private_skill_id
             WHERE v.id = $1`,
            [row.private_skill_version_id]
          );
          return {
            created: false,
            mutation: mapPrivateSkillMutation(row),
            version: versionResult.rowCount ? mapPrivateSkillVersion(versionResult.rows[0]) : null
          };
        }

        let skillResult = await client.query(
          `SELECT * FROM private_skills
           WHERE authority = $1 AND owner_bot_id = $2 AND local_skill_id = $3
           FOR UPDATE`,
          [envelope.authority, envelope.ownerBotId, envelope.localSkillId]
        );
        if (!skillResult.rowCount) {
          if (envelope.operation === "replace") {
            throw new ValidationError(
              "The private Skill previous version is stale.",
              "MUTATION_PREVIOUS_VERSION_STALE",
              409
            );
          }
          skillResult = await client.query(
            `INSERT INTO private_skills
               (id, skill_id, authority, owner_bot_id, local_skill_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [
              versionInput.privateSkillId,
              versionInput.skillId,
              envelope.authority,
              envelope.ownerBotId,
              envelope.localSkillId,
              versionInput.createdAt
            ]
          );
        }
        const skill = skillResult.rows[0];
        // Reserve the expected predecessor while the owner lock is held. A
        // pending reservation must block a different mutation too, because
        // Git/artifact activation happens after this transaction commits.
        const pendingResult = await client.query(
          `SELECT id
           FROM private_skill_versions
           WHERE private_skill_id = $1 AND status = 'pending'
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE`,
          [skill.id]
        );
        if (pendingResult.rowCount) {
          throw new ValidationError(
            "Another private Skill mutation is already in progress.",
            "MUTATION_PREVIOUS_VERSION_STALE",
            409
          );
        }
        const latestResult = await client.query(
          `SELECT *
           FROM private_skill_versions
           WHERE private_skill_id = $1 AND status = 'active'
           ORDER BY activated_at DESC NULLS LAST, created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [skill.id]
        );
        const latest = latestResult.rows[0] ?? null;
        if (envelope.operation === "create" && latest) {
          throw new ValidationError(
            "A private Skill with this local id already exists.",
            "MUTATION_PREVIOUS_VERSION_STALE",
            409
          );
        }
        if (envelope.operation === "replace" && (
          !latest
          || latest.version !== envelope.beforeReference?.version
          || latest.content_hash !== envelope.beforeReference?.contentHash
        )) {
          throw new ValidationError(
            "The private Skill previous version is stale.",
            "MUTATION_PREVIOUS_VERSION_STALE",
            409
          );
        }
        let versionResult = await client.query(
          `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
           FROM private_skill_versions v
           JOIN private_skills s ON s.id = v.private_skill_id
           WHERE v.private_skill_id = $1 AND v.content_hash = $2
           FOR UPDATE`,
          [skill.id, envelope.candidateContentHash]
        );
        if (!versionResult.rowCount) {
          const quota = await client.query(
            `SELECT count(*)::bigint AS version_count,
                    coalesce(sum(v.total_bytes), 0)::bigint AS total_bytes
             FROM private_skill_versions v
             JOIN private_skills s ON s.id = v.private_skill_id
             WHERE s.authority = $1 AND s.owner_bot_id = $2
               AND v.status IN ('pending', 'active')`,
            [envelope.authority, envelope.ownerBotId]
          );
          const versionCount = Number(quota.rows[0]?.version_count ?? 0);
          const totalBytes = Number(quota.rows[0]?.total_bytes ?? 0);
          if (
            versionCount + 1 > envelope.maxVersionsPerBot
            || totalBytes + envelope.candidateSizeBytes > envelope.maxBytesPerBot
          ) {
            throw new ValidationError("Bot private Skill storage quota exceeded.", "PRIVATE_SKILL_QUOTA_EXCEEDED", 429);
          }
          const inserted = await client.query(
            `INSERT INTO private_skill_versions
               (id, private_skill_id, version, name, content_hash, origin, status,
                package_path, package_sha256, package_bytes, file_count, total_bytes,
                failure_code, created_at, updated_at, lease_expires_at, attempt_count)
             VALUES ($1,$2,$3,$4,$5,$6,'pending','','',0,$7,$8,'',$9,$9,$10,1)
             RETURNING *`,
            [
              versionInput.privateVersionId,
              skill.id,
              versionInput.version,
              envelope.name,
              envelope.candidateContentHash,
              null,
              envelope.input.files.length,
              envelope.candidateSizeBytes,
              versionInput.createdAt,
              versionInput.leaseExpiresAt
            ]
          );
          versionResult = {
            rows: [{
              ...inserted.rows[0],
              skill_id: skill.skill_id,
              authority: skill.authority,
              owner_bot_id: skill.owner_bot_id,
              local_skill_id: skill.local_skill_id
            }],
            rowCount: 1
          };
        } else {
          const row = versionResult.rows[0];
          if (row.status === "rejected" && [
            "MUTATION_WRITE_RETRYABLE",
            "MUTATION_ACTIVATION_RETRYABLE",
            "PRIVATE_SKILL_WRITE_RETRYABLE",
            "PRIVATE_SKILL_ACTIVATION_RETRYABLE",
            "PRIVATE_SKILL_PENDING_EXPIRED"
          ].includes(row.failure_code)) {
            const rearmed = await client.query(
              `UPDATE private_skill_versions
               SET status = 'pending', failure_code = '', updated_at = now(),
                   lease_expires_at = $2, attempt_count = attempt_count + 1
               WHERE id = $1
               RETURNING *`,
              [row.id, versionInput.leaseExpiresAt]
            );
            versionResult = {
              rows: [{ ...rearmed.rows[0], skill_id: skill.skill_id, authority: skill.authority, owner_bot_id: skill.owner_bot_id, local_skill_id: skill.local_skill_id }],
              rowCount: 1
            };
          }
        }
        const version = versionResult.rows[0];
        const mutationResult = await client.query(
          `INSERT INTO private_skill_mutations
             (id, authority, owner_bot_id, mutation_id, grant_id, local_skill_id,
              actor_user_id, source_topic_id, source_message_id, runtime_body_id,
              client_request_id, operation, candidate_content_hash, candidate_size_bytes,
              expected_previous_content_hash, before_reference, request_fingerprint,
              private_skill_version_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending')
           RETURNING *`,
          [
            versionInput.mutationRecordId,
            envelope.authority,
            envelope.ownerBotId,
            envelope.mutationId,
            envelope.grantId,
            envelope.localSkillId,
            envelope.actorUserUid,
            envelope.sourceTopicId,
            envelope.sourceMessageId,
            envelope.runtimeBodyId,
            envelope.clientRequestId,
            envelope.operation,
            envelope.candidateContentHash,
            envelope.candidateSizeBytes,
            envelope.expectedPreviousHash,
            envelope.beforeReference ? toJsonParam(envelope.beforeReference) : null,
            envelope.requestFingerprint,
            version.id
          ]
        );
        return {
          created: true,
          mutation: mapPrivateSkillMutation(mutationResult.rows[0]),
          version: mapPrivateSkillVersion(version)
        };
      });
    },

    async findLatestPrivateSkillVersion({ authority, ownerBotId, localSkillId }) {
      const result = await query(
        `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
         FROM private_skill_versions v
         JOIN private_skills s ON s.id = v.private_skill_id
         WHERE s.authority = $1 AND s.owner_bot_id = $2
           AND s.local_skill_id = $3 AND v.status = 'active'
         ORDER BY v.activated_at DESC NULLS LAST, v.created_at DESC
         LIMIT 1`,
        [authority, ownerBotId, localSkillId]
      );
      return result.rowCount ? mapPrivateSkillVersion(result.rows[0]) : null;
    },

    async findPrivateSkillMutation({ authority, ownerBotId, mutationId }) {
      const result = await query(
        `SELECT * FROM private_skill_mutations
         WHERE authority = $1 AND owner_bot_id = $2 AND mutation_id = $3`,
        [authority, ownerBotId, mutationId]
      );
      return result.rowCount ? mapPrivateSkillMutation(result.rows[0]) : null;
    },

    async activatePrivateSkillMutation({ authority, ownerBotId, mutationId, activation }) {
      return tx(async (client) => {
        const ownerLock = JSON.stringify([authority, ownerBotId]);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [ownerLock]);
        const mutationResult = await client.query(
          `SELECT * FROM private_skill_mutations
           WHERE authority = $1 AND owner_bot_id = $2 AND mutation_id = $3
           FOR UPDATE`,
          [authority, ownerBotId, mutationId]
        );
        if (!mutationResult.rowCount) return null;
        const mutation = mutationResult.rows[0];
        const updated = await client.query(
          `UPDATE private_skill_versions
           SET status = 'active', package_path = $2, package_sha256 = $3,
               package_bytes = $4, storage_backend = $5, git_repository_id = $6,
               git_commit_sha = $7, git_tree_sha = $8, git_tag = $9,
               artifact_sha256 = $10, failure_code = '', updated_at = now(),
               lease_expires_at = NULL, activated_at = coalesce(activated_at, now())
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [
            mutation.private_skill_version_id,
            activation.packagePath,
            activation.packageSha256,
            activation.packageBytes,
            activation.storageBackend,
            activation.gitRepositoryId,
            activation.gitCommitSha,
            activation.gitTreeSha,
            activation.gitTag,
            activation.artifactSha256
          ]
        );
        let version;
        if (updated.rowCount) {
          const joined = await client.query(
            `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
             FROM private_skill_versions v JOIN private_skills s ON s.id = v.private_skill_id
             WHERE v.id = $1`,
            [mutation.private_skill_version_id]
          );
          version = joined.rows[0];
        } else {
          const existing = await client.query(
            `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
             FROM private_skill_versions v JOIN private_skills s ON s.id = v.private_skill_id
             WHERE v.id = $1`,
            [mutation.private_skill_version_id]
          );
          version = existing.rows[0];
          if (!version || version.status !== "active" || version.git_commit_sha !== activation.gitCommitSha || version.git_tree_sha !== activation.gitTreeSha || version.git_tag !== activation.gitTag || version.package_sha256 !== activation.packageSha256) {
            throw new ValidationError("Private Skill mutation activation facts conflict.", "MUTATION_IMMUTABLE_CONFLICT", 409);
          }
        }
        const activated = await client.query(
          `UPDATE private_skill_mutations
           SET status = 'active', failure_code = '', updated_at = now(), activated_at = coalesce(activated_at, now())
           WHERE id = $1
           RETURNING *`,
          [mutation.id]
        );
        return { mutation: mapPrivateSkillMutation(activated.rows[0] ?? mutation), version: mapPrivateSkillVersion(version) };
      });
    },

    async rejectPrivateSkillMutation({ authority, ownerBotId, mutationId, failureCode }) {
      await query(
        `UPDATE private_skill_mutations
         SET status = 'rejected', failure_code = $4, updated_at = now()
         WHERE authority = $1 AND owner_bot_id = $2 AND mutation_id = $3 AND status = 'pending'`,
        [authority, ownerBotId, mutationId, String(failureCode ?? "MUTATION_WRITE_RETRYABLE").slice(0, 120)]
      );
    },

    async reservePrivateSkillVersion(input) {
      return tx(async (client) => {
        // PostgreSQL text values cannot contain NUL bytes. Encode the two
        // identity components structurally so the advisory-lock key remains
        // unambiguous without sending an invalid database parameter.
        const ownerLock = JSON.stringify([input.authority, input.ownerBotId]);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [ownerLock]);
        await client.query(
          `UPDATE private_skill_versions v
           SET status = 'rejected',
               failure_code = 'PRIVATE_SKILL_PENDING_EXPIRED',
               updated_at = now(),
               lease_expires_at = NULL
           FROM private_skills s
           WHERE s.id = v.private_skill_id
             AND s.authority = $1
             AND s.owner_bot_id = $2
             AND v.status = 'pending'
             AND (v.lease_expires_at IS NULL OR v.lease_expires_at < now())`,
          [input.authority, input.ownerBotId]
        );
        let skillResult = await client.query(
          `SELECT *
           FROM private_skills
           WHERE authority = $1 AND owner_bot_id = $2 AND local_skill_id = $3
           FOR UPDATE`,
          [input.authority, input.ownerBotId, input.localSkillId]
        );
        if (!skillResult.rowCount) {
          skillResult = await client.query(
            `INSERT INTO private_skills
               (id, skill_id, authority, owner_bot_id, local_skill_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [
              input.privateSkillId,
              input.skillId,
              input.authority,
              input.ownerBotId,
              input.localSkillId,
              input.createdAt
            ]
          );
        }
        const skill = skillResult.rows[0];
        const existing = await client.query(
          `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
           FROM private_skill_versions v
           JOIN private_skills s ON s.id = v.private_skill_id
           WHERE v.private_skill_id = $1 AND v.content_hash = $2`,
          [skill.id, input.contentHash]
        );
        if (existing.rowCount) {
          let row = existing.rows[0];
          if (
            row.status === "rejected"
            && [
              "PRIVATE_SKILL_PENDING_EXPIRED",
              "PRIVATE_SKILL_WRITE_RETRYABLE",
              "PRIVATE_SKILL_ACTIVATION_RETRYABLE"
            ].includes(row.failure_code)
          ) {
            const rearmed = await client.query(
              `UPDATE private_skill_versions
               SET status = 'pending',
                   failure_code = '',
                   updated_at = now(),
                   lease_expires_at = $2,
                   attempt_count = attempt_count + 1
               WHERE id = $1
               RETURNING *`,
              [row.id, input.leaseExpiresAt]
            );
            row = {
              ...rearmed.rows[0],
              skill_id: skill.skill_id,
              authority: skill.authority,
              owner_bot_id: skill.owner_bot_id,
              local_skill_id: skill.local_skill_id
            };
          }
          return { created: false, version: mapPrivateSkillVersion(row) };
        }

        const quota = await client.query(
          `SELECT count(*)::bigint AS version_count,
                  coalesce(sum(v.total_bytes), 0)::bigint AS total_bytes
           FROM private_skill_versions v
           JOIN private_skills s ON s.id = v.private_skill_id
           WHERE s.authority = $1
             AND s.owner_bot_id = $2
             AND v.status IN ('pending', 'active')`,
          [input.authority, input.ownerBotId]
        );
        const versionCount = Number(quota.rows[0]?.version_count ?? 0);
        const totalBytes = Number(quota.rows[0]?.total_bytes ?? 0);
        if (
          versionCount + 1 > input.maxVersionsPerBot
          || totalBytes + input.totalBytes > input.maxBytesPerBot
        ) {
          throw new ValidationError("Bot private Skill storage quota exceeded.", "PRIVATE_SKILL_QUOTA_EXCEEDED", 429);
        }

        const inserted = await client.query(
          `INSERT INTO private_skill_versions
             (id, private_skill_id, version, name, content_hash, origin, status,
              package_path, package_sha256, package_bytes, file_count, total_bytes,
              failure_code, created_at, updated_at, lease_expires_at, attempt_count)
           VALUES ($1,$2,$3,$4,$5,$6,'pending','','',0,$7,$8,'',$9,$9,$10,1)
           RETURNING *`,
          [
            input.privateVersionId,
            skill.id,
            input.version,
            input.name,
            input.contentHash,
            input.origin ? toJsonParam(input.origin) : null,
            input.fileCount,
            input.totalBytes,
            input.createdAt,
            input.leaseExpiresAt
          ]
        );
        return {
          created: true,
          version: mapPrivateSkillVersion({
            ...inserted.rows[0],
            skill_id: skill.skill_id,
            authority: skill.authority,
            owner_bot_id: skill.owner_bot_id,
            local_skill_id: skill.local_skill_id
          })
        };
      });
    },

    async activatePrivateSkillVersion({
      id,
      packagePath,
      packageSha256,
      packageBytes,
      storageBackend = "legacy-fs",
      gitRepositoryId = null,
      gitCommitSha = null,
      gitTreeSha = null,
      gitTag = null,
      artifactSha256 = null
    }) {
      const result = await query(
        `UPDATE private_skill_versions
         SET status = 'active',
             package_path = $2,
             package_sha256 = $3,
             package_bytes = $4,
             storage_backend = $5,
             git_repository_id = $6,
             git_commit_sha = $7,
             git_tree_sha = $8,
             git_tag = $9,
             artifact_sha256 = $10,
             failure_code = '',
             updated_at = now(),
             lease_expires_at = NULL,
             activated_at = coalesce(activated_at, now())
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [
          id,
          packagePath,
          packageSha256,
          packageBytes,
          storageBackend,
          gitRepositoryId,
          gitCommitSha,
          gitTreeSha,
          gitTag,
          artifactSha256
        ]
      );
      if (!result.rowCount) {
        const existing = await query(
          `SELECT package_path, package_sha256, package_bytes, status, storage_backend,
                  git_repository_id, git_commit_sha, git_tree_sha, git_tag, artifact_sha256
           FROM private_skill_versions
           WHERE id = $1`,
          [id]
        );
        const row = existing.rows[0];
        if (
          !row
          || row.status !== "active"
          || row.package_path !== packagePath
          || row.package_sha256 !== packageSha256
          || Number(row.package_bytes) !== Number(packageBytes)
          || row.storage_backend !== storageBackend
          || row.git_repository_id !== gitRepositoryId
          || row.git_commit_sha !== gitCommitSha
          || row.git_tree_sha !== gitTreeSha
          || row.git_tag !== gitTag
          || row.artifact_sha256 !== artifactSha256
        ) {
          return null;
        }
      }
      const joined = await query(
        `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
         FROM private_skill_versions v
         JOIN private_skills s ON s.id = v.private_skill_id
         WHERE v.id = $1`,
        [id]
      );
      return joined.rowCount ? mapPrivateSkillVersion(joined.rows[0]) : null;
    },

    async rejectPrivateSkillVersion({ id, failureCode }) {
      await query(
        `UPDATE private_skill_versions
         SET status = 'rejected',
             failure_code = $2,
             updated_at = now(),
             lease_expires_at = NULL
         WHERE id = $1 AND status = 'pending'`,
        [id, String(failureCode ?? "PRIVATE_SKILL_REJECTED").slice(0, 120)]
      );
    },

    async findPrivateSkillVersion({ authority, ownerBotId, skillId, version }) {
      const result = await query(
        `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
         FROM private_skill_versions v
         JOIN private_skills s ON s.id = v.private_skill_id
         WHERE s.authority = $1
           AND s.owner_bot_id = $2
           AND s.skill_id = $3
           AND v.version = $4
           AND v.status = 'active'`,
        [authority, ownerBotId, skillId, version]
      );
      return result.rowCount ? mapPrivateSkillVersion(result.rows[0]) : null;
    },

    async findActivePrivateSkillVersionByContent({ authority, ownerBotId, localSkillId, contentHash }) {
      const result = await query(
        `SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
         FROM private_skill_versions v
         JOIN private_skills s ON s.id = v.private_skill_id
         WHERE s.authority = $1
           AND s.owner_bot_id = $2
           AND s.local_skill_id = $3
           AND v.content_hash = $4
           AND v.status = 'active'`,
        [authority, ownerBotId, localSkillId, contentHash]
      );
      return result.rowCount ? mapPrivateSkillVersion(result.rows[0]) : null;
    },

    async findPrivateSkillMetadata({ authority, ownerBotId, references }) {
      if (!Array.isArray(references) || references.length === 0) return [];
      const result = await query(
        `WITH requested AS (
           SELECT skill_id, version
           FROM jsonb_to_recordset($3::jsonb) AS item(skill_id text, version text)
         ), ranked_versions AS (
           SELECT v.*,
                  row_number() OVER (
                    PARTITION BY v.private_skill_id
                    ORDER BY coalesce(v.activated_at, v.created_at), v.created_at, v.id
                  ) AS revision_number
           FROM private_skill_versions v
           JOIN private_skills scoped_skill ON scoped_skill.id = v.private_skill_id
           WHERE scoped_skill.authority = $1
             AND scoped_skill.owner_bot_id = $2
             AND v.status = 'active'
         )
         SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id,
                mutation.has_conversation_mutation, mutation.last_changed_at
         FROM ranked_versions v
         JOIN private_skills s ON s.id = v.private_skill_id
         JOIN requested r ON r.skill_id = s.skill_id AND r.version = v.version
         LEFT JOIN LATERAL (
           SELECT true AS has_conversation_mutation,
                  coalesce(m.activated_at, m.created_at) AS last_changed_at
           FROM private_skill_mutations m
           WHERE m.private_skill_version_id = v.id AND m.status = 'active'
           ORDER BY m.activated_at DESC NULLS LAST, m.created_at DESC, m.id DESC
           LIMIT 1
         ) mutation ON true
         WHERE s.authority = $1
           AND s.owner_bot_id = $2
        `,
        [authority, ownerBotId, JSON.stringify(references.map(reference => ({
          skill_id: reference.skillId,
          version: reference.version
        })))]
      );
      const byReference = new Map(result.rows.map(row => {
        const version = mapPrivateSkillVersion(row);
        return [`${version.skillId}\0${version.version}`, version];
      }));
      return references
        .map(reference => byReference.get(`${reference.skillId}\0${reference.version}`))
        .filter(Boolean);
    },

    async listPrivateSkillHistory({ authority, ownerBotId, skillId, limit = 50, beforeRevisionNumber = null }) {
      const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const result = await query(
        `WITH ranked_versions AS (
           SELECT v.*,
                  row_number() OVER (
                    PARTITION BY v.private_skill_id
                    ORDER BY coalesce(v.activated_at, v.created_at), v.created_at, v.id
                  ) AS revision_number
           FROM private_skill_versions v
           JOIN private_skills scoped_skill ON scoped_skill.id = v.private_skill_id
           WHERE scoped_skill.authority = $1
             AND scoped_skill.owner_bot_id = $2
             AND scoped_skill.skill_id = $3
             AND v.status = 'active'
         )
         SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id,
                mutation.has_conversation_mutation, mutation.last_changed_at
         FROM ranked_versions v
         JOIN private_skills s ON s.id = v.private_skill_id
         LEFT JOIN LATERAL (
           SELECT true AS has_conversation_mutation,
                  coalesce(m.activated_at, m.created_at) AS last_changed_at
           FROM private_skill_mutations m
           WHERE m.private_skill_version_id = v.id AND m.status = 'active'
           ORDER BY m.activated_at DESC NULLS LAST, m.created_at DESC, m.id DESC
           LIMIT 1
         ) mutation ON true
         WHERE ($4::bigint IS NULL OR v.revision_number < $4)
         ORDER BY v.revision_number DESC
         LIMIT $5`,
        [authority, ownerBotId, skillId, beforeRevisionNumber, cappedLimit + 1]
      );
      const versions = result.rows.map(mapPrivateSkillVersion);
      const hasMore = versions.length > cappedLimit;
      if (hasMore) versions.pop();
      return {
        versions,
        nextBeforeRevisionNumber: hasMore && versions.length
          ? versions[versions.length - 1].revisionNumber
          : null
      };
    },

    async privateSkillReadiness() {
      const result = await query(
        `SELECT
           EXISTS (
             SELECT 1 FROM schema_migrations
             WHERE id = '005_git_backed_skill_versions'
           ) AS migration_applied,
           EXISTS (
             SELECT 1 FROM schema_migrations
             WHERE id = '006_private_skill_mutations'
           ) AS mutation_migration_applied,
           to_regclass('private_skills') IS NOT NULL AS skills_table,
           to_regclass('private_skill_versions') IS NOT NULL AS versions_table,
           EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'private_skill_versions'
               AND column_name = 'git_commit_sha'
           ) AS git_columns`
      );
      const row = result.rows[0] ?? {};
      const migrationApplied = Boolean(row.migration_applied);
      const mutationMigrationApplied = Boolean(row.mutation_migration_applied);
      const skillsTable = Boolean(row.skills_table);
      const versionsTable = Boolean(row.versions_table);
      const gitColumns = Boolean(row.git_columns);
      return {
        ready: migrationApplied && mutationMigrationApplied && skillsTable && versionsTable && gitColumns,
        migrationApplied,
        mutationMigrationApplied,
        skillsTable,
        versionsTable,
        gitColumns
      };
    },

    async incrementDownload({ packageVersionId, userId, ip, userAgent }) {
      await ensureSimplifiedSchema();
      await query(`UPDATE skill_versions SET download_count = download_count + 1 WHERE id = $1`, [packageVersionId]);
      try {
        await query(
          `INSERT INTO downloads (id, package_version_id, user_id, ip_hash, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [generateId("dl"), packageVersionId, userId ?? null, ip ? sha256(ip).slice(0, 16) : "", userAgent ?? ""]
        );
      } catch (_error) {
        // Older deployments may keep downloads.package_version_id tied to the retired package_versions table.
        // Download counters on skill_versions are the source of truth for the simplified SkillHub.
      }
    },

    async appendAudit(entry) {
      await query(
        `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, resource_type, resource_id, metadata, ip, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          entry.id,
          entry.actorId,
          entry.actorRole,
          entry.action,
          entry.resourceType,
          entry.resourceId,
          toJsonParam(entry.metadata),
          entry.ip,
          entry.createdAt
        ]
      );
    },

    async listAuditLogs({ action = "", resourceType = "", actorUserId = "", limit = 100 } = {}) {
      const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
      const result = await query(
        `SELECT * FROM audit_logs
         WHERE ($1 = '' OR action = $1)
           AND ($2 = '' OR resource_type = $2)
           AND ($3 = '' OR actor_user_id = $3)
         ORDER BY created_at DESC
         LIMIT $4`,
        [
          String(action ?? "").trim(),
          String(resourceType ?? "").trim(),
          String(actorUserId ?? "").trim(),
          cappedLimit
        ]
      );
      return result.rows.map(mapAuditLog);
    }
  };
}

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    status: row.status,
    emailVerified: row.email_verified,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapSession(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    email: row.email,
    displayName: row.display_name,
    userStatus: row.user_status,
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at)
  };
}

function mapDeveloperApplication(row) {
  return {
    id: row.id,
    userId: row.user_id,
    namespace: row.namespace,
    displayName: row.display_name,
    contact: row.contact,
    websiteUrl: row.website_url,
    reason: row.reason,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewComment: row.review_comment,
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapDeveloperProfile(row) {
  return {
    id: row.id,
    userId: row.user_id,
    namespace: row.namespace,
    displayName: row.display_name,
    contact: row.contact,
    websiteUrl: row.website_url,
    catsCoUid: row.catsco_uid || null,
    status: row.status || "active",
    approvedBy: row.approved_by || null,
    approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapSubmission(row) {
  return {
    id: row.id,
    submitterId: row.submitter_id,
    submitterName: row.submitter_name,
    status: row.status,
    normalizedManifest: row.normalized_manifest,
    uploadSha256: row.upload_sha256,
    uploadSummary: row.upload_summary,
    notes: row.notes,
    latestScanRunId: row.latest_scan_run_id,
    scanSummary: row.scan_summary,
    riskLevel: row.risk_level,
    publishedPackageVersionId: row.published_package_version_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapScanRun(row) {
  return {
    id: row.id,
    submissionId: row.submission_id,
    status: row.status,
    riskLevel: row.risk_level,
    summary: row.summary,
    findings: row.findings,
    inventory: row.inventory,
    scannerVersion: row.scanner_version,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at)
  };
}

function mapSkillScan(row) {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    uploadId: row.upload_id,
    status: row.status,
    riskLevel: row.risk_level,
    summary: row.summary,
    findings: row.findings,
    inventory: row.inventory,
    scannerVersion: row.scanner_version,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at)
  };
}

function mapPackageVersion(row) {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    displayName: row.display_name,
    version: row.version,
    status: row.status,
    packagePath: row.package_path,
    packageFile: row.package_file,
    packageUrl: row.package_url,
    packageSize: Number(row.package_size),
    checksumSha256: row.checksum_sha256,
    payloadSha256: row.payload_sha256,
    contentHash: row.content_hash,
    signature: row.signature,
    manifest: row.manifest,
    submissionId: row.submission_id || row.upload_id,
    uploadId: row.upload_id || row.submission_id,
    scanRunId: row.scan_run_id,
    riskLevel: row.risk_level,
    scanSummary: row.scan_summary,
    findings: row.findings,
    publishedAt: iso(row.published_at),
    yankedAt: iso(row.yanked_at),
    deprecatedAt: iso(row.deprecated_at),
      downloadCount: Number(row.download_count ?? 0),
      createdAt: iso(row.created_at),
      ownerUserId: row.owner_user_id,
      visibilityScope: row.visibility_scope || "public",
      visibilityRevision: Number(row.visibility_revision ?? 1),
      visibilityUpdatedAt: iso(row.visibility_updated_at),
      publisherDisplayName: row.publisher_display_name || null,
      publisherContact: row.publisher_contact || null,
      storageBackend: row.storage_backend || "legacy-fs",
      gitRepositoryId: row.git_repository_id || null,
      gitCommitSha: row.git_commit_sha || null,
      gitTreeSha: row.git_tree_sha || null,
      gitTag: row.git_tag || null,
      artifactSha256: row.artifact_sha256 || null
    };
  }

function mapAdminSkill(row) {
  return {
    id: row.id,
    skillId: row.id,
    namespace: String(row.id || "").split("/")[0] || "unknown",
    name: row.name,
    skillName: row.name,
    displayName: row.display_name,
    ownerUserId: row.owner_user_id,
    latestVersion: row.latest_version,
    status: row.status,
    versionCount: Number(row.version_count ?? 0),
    publishedVersionCount: Number(row.published_version_count ?? 0),
    downloadCount: Number(row.total_download_count ?? 0),
    riskLevel: row.latest_risk_level || "unknown",
    updatedAt: iso(row.updated_at),
    lastPublishedAt: iso(row.last_published_at)
  };
}

function mapAuditLog(row) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata,
    ip: row.ip,
    createdAt: iso(row.created_at)
  };
}

function mapJob(row) {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: iso(row.run_after),
    lockedBy: row.locked_by,
    lockedAt: iso(row.locked_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapPrivateSkillVersion(row) {
  return {
    id: row.id,
    privateSkillId: row.private_skill_id,
    skillId: row.skill_id,
    version: row.version,
    authority: row.authority,
    ownerBotId: row.owner_bot_id,
    localSkillId: row.local_skill_id,
    name: row.name,
    contentHash: row.content_hash,
    origin: row.origin ?? undefined,
    status: row.status,
    packagePath: row.package_path,
    packageSha256: row.package_sha256,
    packageBytes: Number(row.package_bytes ?? 0),
    fileCount: Number(row.file_count ?? 0),
    totalBytes: Number(row.total_bytes ?? 0),
    failureCode: row.failure_code || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined,
    attemptCount: Number(row.attempt_count ?? 1),
    activatedAt: row.activated_at ? iso(row.activated_at) : undefined,
    storageBackend: row.storage_backend || "legacy-fs",
    gitRepositoryId: row.git_repository_id || null,
    gitCommitSha: row.git_commit_sha || null,
    gitTreeSha: row.git_tree_sha || null,
    gitTag: row.git_tag || null,
    artifactSha256: row.artifact_sha256 || null,
    revisionNumber: Number(row.revision_number ?? 0),
    hasConversationMutation: Boolean(row.has_conversation_mutation),
    lastChangedAt: row.last_changed_at ? iso(row.last_changed_at) : null
  };
}

function mapPrivateSkillMutation(row) {
  return {
    id: row.id,
    authority: row.authority,
    ownerBotId: row.owner_bot_id,
    mutationId: Number(row.mutation_id),
    grantId: row.grant_id,
    localSkillId: row.local_skill_id,
    actorUserUid: Number(row.actor_user_id),
    sourceTopicId: row.source_topic_id,
    sourceMessageId: Number(row.source_message_id),
    runtimeBodyId: row.runtime_body_id,
    clientRequestId: row.client_request_id,
    operation: row.operation,
    candidateContentHash: row.candidate_content_hash,
    candidateSizeBytes: Number(row.candidate_size_bytes),
    expectedPreviousHash: row.expected_previous_content_hash || "",
    beforeReference: row.before_reference ?? undefined,
    requestFingerprint: row.request_fingerprint,
    privateSkillVersionId: row.private_skill_version_id,
    status: row.status,
    failureCode: row.failure_code || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    activatedAt: row.activated_at ? iso(row.activated_at) : undefined
  };
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function iso(value) {
  if (!value) return null;
  return value.toISOString ? value.toISOString() : value;
}

function sanitizeError(error) {
  const message = error?.message ?? String(error);
  return message.replace(/([A-Za-z0-9_]{8})[A-Za-z0-9_\-]{12,}([A-Za-z0-9_]{4})/g, "$1...$2").slice(0, 1000);
}

function toJsonParam(value) {
  return JSON.stringify(value ?? null);
}
