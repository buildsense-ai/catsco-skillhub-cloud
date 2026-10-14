import { randomUUID } from 'node:crypto';

const MAX_ATTEMPTS = 3;
export function taskError(status, code, message) {
  return Object.assign(new Error(message), { status, code: `skillhub.publication_task_${code}` });
}

// Never include candidate bytes, request keys, owner IDs or lease tokens in API output.
export function publicTask(row, now = Date.now()) {
  const commitStarted = Boolean(row.commit_started || row.intent?.receipt);
  const expired = new Date(row.expires_at).getTime() <= now && !commitStarted && !['cancelled','published'].includes(row.state);
  return {
    id: row.id, state: expired ? 'expired' : row.state,
    candidateHash: row.candidate_hash, candidateAvailable: !expired && row.candidate_bytes > 0,
    validation: row.validation_result ?? row.intake_result,
    errorCode: expired ? null : row.error_code,
    ...(row.publication_result ? {publication:Object.fromEntries(
      ['skillId','version','packageId','checksumSha256','publishedAt'].map(key=>[key,row.publication_result[key]]))} : {}),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(), purgeAfter: new Date(row.purge_after).toISOString(),
    capabilities: { publish: false, repair: false }
  };
}

export function createPublicationTaskStore({ query, tx }) {
  const transaction = tx;
  tx = fn => transaction(async client => {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    return fn(client);
  });
  // Metadata queries intentionally do not materialize BYTEA candidates.
  const columns = `id, owner_user_id, request_key, request_hash, candidate_hash, candidate_bytes,
    state, intake_result, validation_result, error_code, publication_result, created_at, updated_at, expires_at, purge_after,
    EXISTS(SELECT 1 FROM publication_commits c WHERE c.task_id=publication_tasks.id AND c.receipt IS NOT NULL) AS commit_started`;
  const retained = `(purge_after>now() OR (state<>'published' AND EXISTS
    (SELECT 1 FROM publication_commits c WHERE c.task_id=publication_tasks.id AND c.receipt IS NOT NULL)))`;
  async function maintain(client) {
    await client.query(`UPDATE publication_tasks SET candidate=NULL, candidate_bytes=0,
      state=CASE WHEN state='cancelled' THEN state ELSE 'expired' END,
      lease_token=NULL, lease_until=NULL, updated_at=now()
      WHERE id IN (SELECT id FROM publication_tasks WHERE expires_at<=now()
        AND NOT EXISTS(SELECT 1 FROM publication_commits c WHERE c.task_id=publication_tasks.id AND c.receipt IS NOT NULL)
        AND (candidate IS NOT NULL OR state NOT IN ('expired','cancelled','published')) LIMIT 500 FOR UPDATE SKIP LOCKED)`);
    await client.query(`DELETE FROM publication_tasks WHERE id IN
      (SELECT id FROM publication_tasks WHERE purge_after<=now() AND NOT ${retained} LIMIT 500 FOR UPDATE SKIP LOCKED)`);
  }
  async function getPublicationTask(ownerId, id) {
    const result = await query(`SELECT ${columns} FROM publication_tasks WHERE id=$1 AND owner_user_id=$2 AND ${retained}`, [id, ownerId]);
    return result.rowCount ? publicTask(result.rows[0]) : null;
  }
  return {
    async findPublicationTaskForRequest(ownerId, requestKey, requestHash) {
      const result = await query(`SELECT ${columns} FROM publication_tasks WHERE owner_user_id=$1 AND request_key=$2 AND ${retained}`, [ownerId, requestKey]);
      if (!result.rowCount) return null;
      if (result.rows[0].request_hash !== requestHash) throw taskError(409, 'request_conflict', 'Request key was already used for different content.');
      return publicTask(result.rows[0]);
    },
    async createPublicationTask({ ownerId, requestKey, requestHash, candidateHash, candidate, result, settings }) {
      return tx(async client => {
        // Global quota accounting and request insertion are atomic across API processes.
        // No parsing/network/file IO while holding this lock.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('skillhub-publication-task-intake')::bigint)`);
        const active = await client.query(`SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE`, [ownerId]);
        if (!active.rowCount) throw taskError(403, 'owner_inactive', 'Publication task owner is unavailable.');
        await maintain(client);
        const previous = await client.query(`SELECT ${columns} FROM publication_tasks WHERE owner_user_id=$1 AND request_key=$2`, [ownerId, requestKey]);
        if (previous.rowCount) {
          if (previous.rows[0].request_hash !== requestHash) throw taskError(409, 'request_conflict', 'Request key was already used for different content.');
          return { task: publicTask(previous.rows[0]), created: false };
        }
        const usage = (await client.query(`SELECT count(*)::int AS total_count,
          count(*) FILTER (WHERE owner_user_id=$1)::int AS owner_count,
          COALESCE(sum(candidate_bytes+commit_bytes),0)::bigint AS total_bytes,
          COALESCE(sum(candidate_bytes+commit_bytes) FILTER (WHERE owner_user_id=$1),0)::bigint AS owner_bytes
          FROM publication_tasks`, [ownerId])).rows[0];
        const size = candidate?.length ?? 0;
        if (usage.total_count >= settings.maxTasks || usage.owner_count >= settings.maxTasksPerOwner ||
          Number(usage.total_bytes) + size > settings.maxStoredBytes || Number(usage.owner_bytes) + size > settings.maxStoredBytesPerOwner) {
          throw taskError(429, 'storage_limit', 'Publication task storage limit reached.');
        }
        const id = `pubtask_${randomUUID()}`;
        const inserted = await client.query(`INSERT INTO publication_tasks
          (id,owner_user_id,request_key,request_hash,candidate_hash,candidate,candidate_bytes,state,intake_result,expires_at,purge_after)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10::bigint * interval '1 millisecond'),now()+($11::bigint * interval '1 millisecond'))
          RETURNING ${columns}`, [id, ownerId, requestKey, requestHash, candidateHash, candidate, size,
          result.status === 200 ? 'queued' : 'rejected', JSON.stringify(result), settings.candidateTtlMs, settings.retentionMs]);
        return { task: publicTask(inserted.rows[0]), created: true };
      });
    },
    getPublicationTask,
    async listPublicationTasks(ownerId) {
      const result = await query(`SELECT ${columns} FROM publication_tasks WHERE owner_user_id=$1 AND ${retained}
        ORDER BY created_at DESC,id DESC LIMIT 100`, [ownerId]);
      return result.rows.map(row => {
        const { validation, ...summary } = publicTask(row);
        return summary;
      });
    },
    async cancelPublicationTask(ownerId, id) {
      const result = await tx(async client => {
        const current = (await client.query(`SELECT ${columns} FROM publication_tasks WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,[id,ownerId])).rows[0];
        if (current && (current.commit_started || current.state==='published')) throw taskError(409,'commit_started','Publication has entered commit and cannot be cancelled.');
        return client.query(`UPDATE publication_tasks SET state='cancelled',candidate=NULL,candidate_bytes=0,
        lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND purge_after>now() AND expires_at>now() AND state<>'cancelled'
        RETURNING ${columns}`, [id, ownerId]);
      });
      if (result.rowCount) return publicTask(result.rows[0]);
      return getPublicationTask(ownerId, id);
    },
    async maintainPublicationTasks() { return tx(maintain); },
    async claimPublicationTask(settings) {
      return tx(async client => {
        // A timed-out final attempt must become terminal instead of living forever in validating.
        await client.query(`UPDATE publication_tasks SET state='failed', error_code='skillhub.publication_task_attempts_exhausted',
          lease_token=NULL,lease_until=NULL,updated_at=now()
          WHERE id IN (SELECT id FROM publication_tasks WHERE state='validating' AND lease_until<=now()
            AND attempts >= $1 LIMIT 100 FOR UPDATE SKIP LOCKED)`, [MAX_ATTEMPTS]);
        const selected = await client.query(`SELECT id FROM publication_tasks
          WHERE expires_at>now() AND attempts<$1 AND candidate IS NOT NULL
            AND ((state='queued' AND run_after<=now()) OR (state='validating' AND lease_until<=now()))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [MAX_ATTEMPTS]);
        if (!selected.rowCount) return null;
        const result = await client.query(`UPDATE publication_tasks SET state='validating',attempts=attempts+1,
          lease_token=$2,lease_until=now()+($3::bigint * interval '1 millisecond'),updated_at=now()
          WHERE id=$1 RETURNING *`, [selected.rows[0].id, randomUUID(), settings.leaseMs]);
        return result.rows[0];
      });
    },
    async finishPublicationTask(task, { result, errorCode, retry = false }) {
      return tx(async client => {
        const user = await client.query(`SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE`, [task.owner_user_id]);
        const state = !user.rowCount ? 'failed' : result ? (result.status === 200 ? 'ready' : 'rejected')
          : retry && task.attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
        const error = !user.rowCount ? 'skillhub.publication_task_owner_inactive' : errorCode ?? null;
        const updated = await client.query(`UPDATE publication_tasks SET state=$3,validation_result=$4,error_code=$5,
          lease_token=NULL,lease_until=NULL,run_after=now()+interval '5 seconds',updated_at=now()
          WHERE id=$1 AND lease_token=$2 AND state='validating' AND lease_until>now() AND expires_at>now()`,
        [task.id, task.lease_token, state, result ? JSON.stringify(result) : null, error]);
        return updated.rowCount === 1;
      });
    }
  };
}
