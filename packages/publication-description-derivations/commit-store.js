import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../signing/index.js';

const MAX_ATTEMPTS = 3;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (kind, status = 409) => {
  const error = new Error('Description release completion could not be completed.');
  error.code = `skillhub.publication_description_release_commit_${kind}`;
  error.status = status;
  throw error;
};

function transaction(tx, fn) {
  return tx(async client => {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    return fn(client);
  });
}

function validPackageVersion(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && typeof value.skillId === 'string'
    && typeof value.skillName === 'string' && typeof value.displayName === 'string'
    && typeof value.version === 'string' && value.status === 'published' && digest(value.checksumSha256)
    && digest(value.artifactSha256) && value.artifactSha256 === value.checksumSha256
    && typeof value.packagePath === 'string' && typeof value.packageFile === 'string'
    && typeof value.packageUrl === 'string' && digest(value.payloadSha256)
    && Number.isSafeInteger(value.packageSize) && value.packageSize > 0
    && typeof value.publishedAt === 'string' && typeof value.gitRepositoryId === 'string'
    && typeof value.gitCommitSha === 'string' && typeof value.gitTreeSha === 'string'
    && typeof value.gitTag === 'string' && typeof value.submissionId === 'string'
    && typeof value.scanRunId === 'string' && value.manifest && typeof value.manifest === 'object';
}

function validScanRun(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && typeof value.skillId === 'string'
    && typeof value.version === 'string' && typeof value.uploadId === 'string';
}

export function createPublicationDescriptionReleaseCommitStore({ query, tx }) {
  if (typeof query !== 'function' || typeof tx !== 'function') {
    throw new TypeError('Description release commit storage requires query and tx.');
  }
  return {
    async claim(settings, token = `pubdesclease_${randomUUID()}`) {
      return transaction(tx, async client => {
        await client.query(`UPDATE publication_description_release_commits
          SET state='publish_failed',lease_token=NULL,lease_until=NULL,error_code='unavailable',updated_at=clock_timestamp()
          WHERE state='committing' AND attempts>=$1
            AND (lease_token IS NULL OR lease_until<=clock_timestamp())`, [MAX_ATTEMPTS]);
        const selected = (await client.query(`
          SELECT c.application_id,c.task_id,c.permit_id,c.target,c.manifest,c.identity,
            c.state,c.attempts,c.lease_token,c.lease_until,c.receipt,c.checkpoint,
            d.derived_raw_json,d.derived_request_hash,d.derived_candidate_hash
          FROM publication_description_release_commits c
          JOIN publication_description_derivations d USING(application_id)
          WHERE c.state='committing' AND c.attempts<$1
            AND (c.lease_token IS NULL OR c.lease_until<=clock_timestamp())
          ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1`, [MAX_ATTEMPTS])).rows[0];
        if (!selected) return null;
        const claimed = (await client.query(`
          UPDATE publication_description_release_commits
          SET attempts=attempts+1,lease_token=$2,
            lease_until=clock_timestamp()+($3::bigint*interval '1 millisecond'),error_code=NULL
          WHERE application_id=$1 AND state='committing' AND attempts<$4
            AND (lease_token IS NULL OR lease_until<=clock_timestamp())
          RETURNING *`, [selected.application_id, token, settings.leaseMs, MAX_ATTEMPTS])).rows[0];
        return claimed ? { ...claimed,
          derived_raw_json: selected.derived_raw_json,
          derived_request_hash: selected.derived_request_hash,
          derived_candidate_hash: selected.derived_candidate_hash } : null;
      });
    },

    async renew(task, settings) {
      if (!task?.application_id || !task?.lease_token) return false;
      const result = await query(`UPDATE publication_description_release_commits
        SET lease_until=clock_timestamp()+($3::bigint*interval '1 millisecond')
        WHERE application_id=$1 AND state='committing' AND lease_token=$2
          AND lease_until>clock_timestamp()`, [task.application_id, task.lease_token, settings.leaseMs]);
      return result.rowCount === 1;
    },

    async saveCheckpoint(task, checkpoint) {
      if (!validPackageVersion(checkpoint?.packageVersion) || !validScanRun(checkpoint?.scanRun)) fail('invalid');
      return transaction(tx, async client => {
        const row = (await client.query(`SELECT receipt,checkpoint,state FROM publication_description_release_commits
          WHERE application_id=$1 AND state='committing' AND lease_token=$2 AND lease_until>clock_timestamp()
          FOR UPDATE`, [task.application_id, task.lease_token])).rows[0];
        if (!row || row.checkpoint) return row?.checkpoint ?? null;
        if (!row.receipt || checkpoint.packageVersion.submissionId !== task.identity.uploadId
          || checkpoint.packageVersion.skillId !== task.identity.skillId
          || checkpoint.packageVersion.version !== task.identity.version
          || checkpoint.packageVersion.publishedAt !== task.identity.releaseAt
          || checkpoint.scanRun.uploadId !== task.identity.uploadId
          || checkpoint.scanRun.skillId !== task.identity.skillId
          || checkpoint.scanRun.version !== task.identity.version
          || typeof checkpoint.scanRun.status !== 'string' || typeof checkpoint.scanRun.riskLevel !== 'string') fail('conflict');
        const updated = await client.query(`UPDATE publication_description_release_commits
          SET checkpoint=$2,updated_at=clock_timestamp()
          WHERE application_id=$1 AND state='committing' AND lease_token=$3 AND lease_until>clock_timestamp()
          RETURNING checkpoint`, [task.application_id, JSON.stringify(checkpoint), task.lease_token]);
        if (!updated.rowCount) fail('lease_lost');
        return updated.rows[0].checkpoint;
      });
    },

    async fail(task, errorCode, retry = true) {
      if (!task?.application_id || !task?.lease_token) return false;
      return transaction(tx, async client => {
        const terminal = retry === false || task.attempts >= MAX_ATTEMPTS;
        const updated = await client.query(`UPDATE publication_description_release_commits
          SET state=$3,lease_token=NULL,lease_until=NULL,error_code=$4,updated_at=clock_timestamp()
          WHERE application_id=$1 AND state='committing' AND lease_token=$2
            AND lease_until>clock_timestamp()
          RETURNING application_id`, [task.application_id, task.lease_token,
          terminal ? 'publish_failed' : 'committing', errorCode]);
        return updated.rowCount === 1;
      });
    },

    async complete(task, { packageVersion, scanRun, manifest, identity }) {
      if (!validPackageVersion(packageVersion) || !validScanRun(scanRun)
        || !exact(identity, ['ownerId', 'uploadId', 'skillId', 'version', 'releaseAt'])
        || !manifest || typeof manifest !== 'object') fail('invalid');
      return transaction(tx, async client => {
        const row = (await client.query(`
          SELECT c.*,p.target AS plan_target,p.manifest AS plan_manifest,p.identity AS plan_identity,
            a.permit_id AS admission_permit,a.proof AS admission_proof,
            t.state AS source_state,t.authority_kind,t.owner_user_id,t.delegated_cancelled_at,
            d.profile_id,d.namespace,d.actor_uid,d.issuer,
            u.status AS owner_status,pp.status AS profile_status,pp.id AS current_profile_id,
            pp.namespace AS current_namespace,pp.catsco_uid,pp.catsco_issuer,
            EXISTS(SELECT 1 FROM publication_commits old WHERE old.task_id=t.id) AS legacy_commit,
            EXISTS(SELECT 1 FROM publication_delegated_plans old WHERE old.task_id=t.id) AS legacy_plan
          FROM publication_description_release_commits c
          JOIN publication_description_release_plans p USING(application_id,task_id)
          JOIN publication_description_release_admissions a USING(application_id,task_id)
          JOIN publication_tasks t ON t.id=c.task_id
          JOIN publication_delegations d ON d.task_id=t.id
          JOIN users u ON u.id=t.owner_user_id
          LEFT JOIN publisher_profiles pp ON pp.user_id=t.owner_user_id
          WHERE c.application_id=$1 AND c.state='committing' AND c.lease_token=$2
            AND c.lease_until>clock_timestamp() FOR UPDATE OF c,t`, [task.application_id, task.lease_token])).rows[0];
        if (!row || row.state !== 'committing' || !row.checkpoint) fail('conflict');
        if (row.source_state !== 'delegated_pending' || row.authority_kind !== 'catsco'
          || row.delegated_cancelled_at !== null || row.owner_status !== 'active'
          || row.profile_status !== 'active' || row.current_profile_id !== row.target.publisherProfileId
          || row.current_namespace !== row.target.namespace || row.catsco_uid !== row.actor_uid
          || row.catsco_issuer !== row.issuer || row.legacy_commit || row.legacy_plan) fail('publisher_changed', 403);
        if (canonicalJson(row.plan_target) !== canonicalJson(row.target)
          || canonicalJson(row.plan_manifest) !== canonicalJson(row.manifest)
          || canonicalJson(row.plan_identity) !== canonicalJson(row.identity)
          || canonicalJson(row.manifest) !== canonicalJson(manifest)
          || canonicalJson(row.identity) !== canonicalJson(identity)
          || canonicalJson(packageVersion.manifest) !== canonicalJson(manifest)
          || canonicalJson(row.checkpoint.packageVersion) !== canonicalJson(packageVersion)
          || canonicalJson(row.checkpoint.scanRun) !== canonicalJson(scanRun)) fail('conflict');
        if (row.admission_permit !== row.permit_id || canonicalJson(row.admission_proof.target) !== canonicalJson(row.target)
          || row.target.publisherUserId !== row.owner_user_id || row.target.skillId !== packageVersion.skillId
          || row.target.version !== packageVersion.version || row.target.uploadId !== packageVersion.submissionId) fail('conflict');

        const existing = (await client.query('SELECT * FROM skill_versions WHERE skill_id=$1 AND version=$2 FOR UPDATE',
          [packageVersion.skillId, packageVersion.version])).rows[0];
        if (existing && (existing.upload_id !== packageVersion.submissionId
          || existing.checksum_sha256 !== packageVersion.checksumSha256)) fail('conflict');
        if (!existing) {
          const skill = (await client.query('SELECT owner_user_id FROM skills WHERE id=$1 FOR UPDATE', [packageVersion.skillId])).rows[0];
          if (skill && skill.owner_user_id !== row.owner_user_id) fail('publisher_changed', 403);
          const latest = skill?.latest_version && compareVersions(skill.latest_version, packageVersion.version) > 0
            ? skill.latest_version : packageVersion.version;
          await client.query(`INSERT INTO skills (id,name,display_name,owner_user_id,latest_version,status)
            VALUES($1,$2,$3,$4,$5,'published')
            ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,display_name=EXCLUDED.display_name,
              latest_version=EXCLUDED.latest_version,status='published',updated_at=now()`,
          [packageVersion.skillId, packageVersion.skillName, packageVersion.displayName, row.owner_user_id, latest]);
          await client.query(`INSERT INTO skill_scans
            (id,skill_id,version,upload_id,status,risk_level,summary,findings,inventory,scanner_version,started_at,finished_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [scanRun.id,scanRun.skillId,scanRun.version,scanRun.uploadId,scanRun.status,scanRun.riskLevel,
            JSON.stringify(scanRun.summary ?? {}),JSON.stringify(scanRun.findings ?? []),JSON.stringify(scanRun.inventory ?? []),
            scanRun.scannerVersion ?? '0.1.0',scanRun.startedAt ?? packageVersion.publishedAt,scanRun.finishedAt ?? packageVersion.publishedAt]);
          await client.query(`INSERT INTO skill_versions
            (id,skill_id,skill_name,display_name,version,status,package_path,package_file,package_url,
             package_size,checksum_sha256,payload_sha256,content_hash,signature,manifest,owner_user_id,upload_id,scan_run_id,
             risk_level,scan_summary,findings,published_at,storage_backend,git_repository_id,git_commit_sha,git_tree_sha,git_tag,artifact_sha256)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [packageVersion.id,packageVersion.skillId,packageVersion.skillName,packageVersion.displayName,packageVersion.version,
            packageVersion.status,packageVersion.packagePath,packageVersion.packageFile,packageVersion.packageUrl,packageVersion.packageSize,
            packageVersion.checksumSha256,packageVersion.payloadSha256,packageVersion.contentHash ?? null,
            JSON.stringify(packageVersion.signature ?? {}),JSON.stringify(packageVersion.manifest),row.owner_user_id,
            packageVersion.submissionId,packageVersion.scanRunId,packageVersion.riskLevel ?? 'low',
            JSON.stringify(packageVersion.scanSummary ?? {}),JSON.stringify(packageVersion.findings ?? []),packageVersion.publishedAt,
            packageVersion.storageBackend ?? 'git-v1',packageVersion.gitRepositoryId,packageVersion.gitCommitSha,
            packageVersion.gitTreeSha,packageVersion.gitTag,packageVersion.artifactSha256]);
        }
        const result = { skillId: packageVersion.skillId, version: packageVersion.version, packageId: existing?.id ?? packageVersion.id,
          checksumSha256: packageVersion.checksumSha256, publishedAt: packageVersion.publishedAt };
        const completed = await client.query(`UPDATE publication_description_release_commits
          SET state='published',publication_result=$3,lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=clock_timestamp()
          WHERE application_id=$1 AND state='committing' AND lease_token=$2 AND lease_until>clock_timestamp()
          RETURNING application_id,state,publication_result`, [task.applicationId ?? task.application_id, task.lease_token, JSON.stringify(result)]);
        if (!completed.rowCount) fail('lease_lost');
        return completed.rows[0];
      });
    }
  };
}

function compareVersions(left, right) {
  const parse = value => String(value).split(/[+-]/, 1)[0].split('.').map(Number);
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export { validPackageVersion, validScanRun };
