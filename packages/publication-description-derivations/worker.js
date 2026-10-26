import { randomUUID, createHash } from 'node:crypto';
import { runPreparePublication } from '../publication-tasks/prepare.js';
import { publicationTaskSettings } from '../publication-tasks/config.js';
import { PublicationDescriptionDerivationError } from './store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = kind => { throw new PublicationDescriptionDerivationError(`release_commit_${kind}`, kind === 'invalid' ? 400 : 409); };

// This worker stage only claims and prepares an isolated derived commit. It
// never writes publication_commits, creates a job, or publishes a package.
export function createPublicationDescriptionReleaseWorker({ enabled = false, config, store } = {}) {
  if (enabled !== true || !config || !store?.tx || !store?.query) return Object.freeze({
    async once() { return null; }
  });
  let settings;
  try { settings = publicationTaskSettings(config); } catch { return Object.freeze({ async once() { fail('configuration'); } }); }
  if (!settings) return Object.freeze({ async once() { fail('configuration'); } });
  let active = false;
  const tx = fn => store.tx(async client => {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    return fn(client);
  });
  return Object.freeze({
    async once({ signal } = {}) {
      if (active) return null;
      active = true;
      const token = `pubdesclease_${randomUUID()}`;
      try {
        const task = await tx(async client => {
          const row = (await client.query(`SELECT c.application_id,c.task_id,c.permit_id,c.target,c.manifest,c.identity,
              c.state,c.attempts,c.lease_token,c.lease_until,d.derived_raw_json,d.derived_request_hash,
              d.derived_candidate_hash
            FROM publication_description_release_commits c
            JOIN publication_description_derivations d USING(application_id)
            WHERE c.state IN ('queued','publishing') AND c.attempts<3
              AND (c.state='queued' OR c.lease_until<=clock_timestamp())
            ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1`)).rows[0];
          if (!row) return null;
          const claimed = await client.query(`UPDATE publication_description_release_commits
            SET state='publishing',attempts=attempts+1,lease_token=$2,
              lease_until=clock_timestamp()+interval '30 seconds',error_code=NULL
            WHERE application_id=$1 AND state IN ('queued','publishing')
              AND attempts<3 RETURNING *`, [row.application_id, token]);
          if (!claimed.rows[0]) return null;
          // The claim UPDATE only returns columns from the commit table. Carry
          // the immutable retained bytes/hashes from the joined derivation
          // row through the lease boundary so preparation validates the exact
          // bytes that were admitted, without widening the commit table.
          return { ...claimed.rows[0],
            derived_raw_json: row.derived_raw_json,
            derived_request_hash: row.derived_request_hash,
            derived_candidate_hash: row.derived_candidate_hash };
        });
        if (!task) return null;
        if (signal?.aborted) { await failClaim(task, 'unavailable'); return null; }
        if (!Buffer.isBuffer(task.derived_raw_json) || hash(task.derived_raw_json) !== task.derived_request_hash
          || task.target.candidateHash !== task.derived_candidate_hash) { await failClaim(task, 'copy_changed'); return null; }
        const prepared = await runPreparePublication({ rawJson: task.derived_raw_json,
          requestHash: task.derived_request_hash, candidateHash: task.derived_candidate_hash,
          manifest: task.manifest, identity: task.identity }, settings.limits,
        { timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb, signal });
        if (prepared.status !== 200) { await failClaim(task, prepared.status >= 500 ? 'unavailable' : 'rejected'); return null; }
        const completed = await tx(async client => {
          const updated = await client.query(`UPDATE publication_description_release_commits
            SET state='committing',receipt=$2,lease_until=NULL,lease_token=NULL,error_code=NULL
            WHERE application_id=$1 AND state='publishing' AND lease_token=$3 RETURNING application_id,task_id,permit_id,state,target`,
          [task.application_id, JSON.stringify(prepared.prepared.receipt), token]);
          return updated.rows[0] ?? null;
        });
        return completed;
      } finally { active = false; }
    }
  });

  async function failClaim(task, errorCode) {
    await tx(client => client.query(`UPDATE publication_description_release_commits
      SET state=CASE WHEN attempts<3 THEN 'queued' ELSE 'publish_failed' END,
        lease_token=NULL,lease_until=NULL,error_code=$2
      WHERE application_id=$1 AND state='publishing' AND lease_token=$3`, [task.application_id, errorCode, task.lease_token]));
  }
}
