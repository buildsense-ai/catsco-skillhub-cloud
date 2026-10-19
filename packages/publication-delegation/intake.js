import { createHash, randomUUID } from 'node:crypto';
import { requireCatsCoIssuer } from './identity.js';
import { PublicationAuthorityError } from './introspection.js';
import { publicationTaskSettings } from '../publication-tasks/config.js';
import { taskError } from '../publication-tasks/store.js';
import { runPublishValidation } from '../publish-validation/runner.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uid = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const conflict = () => taskError(409,'request_conflict','Publication association conflicts with the accepted request.');
const identityUnavailable = () => taskError(403,'publisher_unverified','An active issuer-bound publisher is required.');

// Called by the separately gated runtime upload adapter. The injected peer
// must be the pinned introspection client, never a browser identity assertion.
export function createDelegatedPublicationIntake({ enabled = false, config, store, introspectionClient, issuer, audience } = {}) {
  let settings;
  if (enabled) {
    if (requireCatsCoIssuer(issuer)!==issuer || !issuer.startsWith('https://') ||
        requireCatsCoIssuer(audience)!==audience || !audience.startsWith('https://')) throw new PublicationAuthorityError('configuration');
    settings = publicationTaskSettings(config);
    if (!settings || !store?.tx || !introspectionClient?.checkUploadGrant) throw new PublicationAuthorityError('configuration');
  }
  let active = 0;
  return async function accept(input, { signal } = {}) {
    if (!enabled) throw new PublicationAuthorityError('disabled');
    if (active >= settings.execution.maxConcurrent) throw new PublicationAuthorityError('busy');
    const keys = ['token','entryRequestId','authorityEpoch','rawBody','sourceSnapshotHash','idempotencyKey'];
    if (!input || Object.keys(input).length!==keys.length || !keys.every(k=>Object.hasOwn(input,k)) ||
        !Buffer.isBuffer(input.rawBody) || !input.rawBody.length || input.rawBody.length>Math.min(75*1024*1024,settings.limits.maxRequestBytes) ||
        !matches(input.token,/^pubupload_[a-f0-9]{64}$/) || !matches(input.entryRequestId,/^pubentry_[a-f0-9]{32}$/) ||
        !matches(input.idempotencyKey,/^pubcandidate_[a-f0-9]{32}$/) || !matches(input.sourceSnapshotHash,/^[a-f0-9]{64}$/) ||
        !Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch<1 || input.authorityEpoch>8) throw new PublicationAuthorityError('invalid');
    active++;
    try {
      // Snapshot before the first await. Caller mutation cannot change the
      // validated, introspected or persisted bytes/metadata independently.
      const request = Object.freeze({ ...input, rawBody: Buffer.from(input.rawBody) });
      const requestHash = hash(request.rawBody);
      const result = await runPublishValidation(request.rawBody, settings.limits, {
        timeoutMs:settings.execution.workerTimeoutMs, memoryMb:settings.execution.workerMemoryMb, signal
      });
      const report = result.body?.validation ?? result.body?.error?.validation;
      if (![200,422].includes(result.status) || report?.coverage!=='complete' || !report.candidateHash) {
        // No unsafe or undecodable material admitted merely to obtain a task.
        return { created:false, accepted:false, validation:result };
      }
      if (report.candidateHash!==request.sourceSnapshotHash) throw taskError(409,'candidate_changed','Captured candidate digest does not match.');
      if (signal?.aborted) throw new PublicationAuthorityError();
      // Maintenance and all validation/network work occur outside intake's tx.
      await store.maintainPublicationTasks();
      const grant = Object.freeze({...await introspectionClient.checkUploadGrant(request,{signal})});
      const observed = Date.parse(grant?.observedAt), expires = Date.parse(grant?.expiresAt);
      if (!grant || grant.issuer!==issuer || grant.audience!==audience || grant.action!=='candidate.upload' ||
          grant.candidateRevision!==1 || grant.entryRequestId!==request.entryRequestId || grant.authorityEpoch!==request.authorityEpoch ||
          grant.requestHash!==requestHash || grant.requestBytes!==request.rawBody.length ||
          grant.sourceSnapshotHash!==report.candidateHash || grant.idempotencyKey!==request.idempotencyKey ||
          !matches(grant.delegationId,/^pubgrant_[a-f0-9]{32}$/) || !uid(grant.actorCatsCoUid) || !uid(grant.botUid) || grant.actorCatsCoUid===grant.botUid ||
          !Number.isFinite(observed) || !Number.isFinite(expires) || observed>Date.now()+5000 ||
          expires<=Date.now() || expires<=observed || expires-observed>120000) throw new PublicationAuthorityError('inactive');
      if (signal?.aborted) throw new PublicationAuthorityError();
      return await store.tx(async client => {
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('skillhub-publication-task-intake')::bigint)");
        // Find a hint without treating it as authority, then lock user before
        // profile (same order as commit authority) and recheck every fact.
        const hint = (await client.query('SELECT user_id FROM publisher_profiles WHERE catsco_uid=$1 AND catsco_issuer=$2',
          [grant.actorCatsCoUid,issuer])).rows[0];
        if (!hint) throw identityUnavailable();
        const user = await client.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE",[hint.user_id]);
        const profile = (await client.query(`SELECT id,user_id,namespace FROM publisher_profiles
          WHERE user_id=$1 AND catsco_uid=$2 AND catsco_issuer=$3 AND status='active' FOR SHARE`,
        [hint.user_id,grant.actorCatsCoUid,issuer])).rows[0];
        if (!user.rowCount || !profile) throw identityUnavailable();
        const live = async () => {
          if (signal?.aborted || !(await client.query('SELECT $1::timestamptz>clock_timestamp() AS live',[grant.expiresAt])).rows[0].live) {
            throw new PublicationAuthorityError('inactive');
          }
        };
        await live();
        const prior = (await client.query(`SELECT d.*,t.owner_user_id,t.request_key,t.request_hash,t.candidate_hash,
          t.candidate_bytes,t.expires_at,t.state,o.event_id FROM publication_delegations d
          JOIN publication_tasks t ON t.id=d.task_id JOIN publication_delegation_outbox o ON o.task_id=d.task_id
          WHERE d.issuer=$1 AND d.entry_request_id=$2 AND d.candidate_revision=1`,[issuer,grant.entryRequestId])).rows[0];
        const receipt = row => ({ taskId:row.task_id, issuer, entryRequestId:row.entry_request_id, candidateRevision:1,
          candidateHash:row.candidate_hash, requestHash:row.request_hash, authorityEpoch:Number(row.authority_epoch),
          eventId:row.event_id, state:row.state,
          candidateAvailable:row.state!=='cancelled' && row.candidate_bytes>0 && new Date(row.expires_at).getTime()>Date.now() });
        if (prior) {
          // Retained identity is immutable; this is a historical observation,
          // not a new execution authority. Do not hold a task row lock while
          // owning the intake quota lock (commit accounting takes reverse order).
          // CatsCo renewal increments the token epoch but preserves grant ID,
          // entry, candidate and key. A live renewal may recover this original
          // receipt; it must not rewrite the accepted epoch or authorize commit.
          if (prior.audience!==audience || prior.actor_uid!==grant.actorCatsCoUid || prior.bot_uid!==grant.botUid ||
              prior.delegation_id!==grant.delegationId || grant.authorityEpoch<Number(prior.authority_epoch) ||
              prior.profile_id!==profile.id || prior.namespace!==profile.namespace ||
              prior.owner_user_id!==profile.user_id || prior.request_key!==request.idempotencyKey ||
              prior.request_hash!==requestHash || prior.candidate_hash!==report.candidateHash) throw conflict();
          await live();
          return {created:false,accepted:true,association:receipt(prior)};
        }
        const collision = await client.query('SELECT 1 FROM publication_tasks WHERE owner_user_id=$1 AND request_key=$2',
          [profile.user_id,request.idempotencyKey]);
        if (collision.rowCount) throw conflict();
        const usage = (await client.query(`SELECT count(*)::int AS total_count,
          count(*) FILTER (WHERE owner_user_id=$1)::int AS owner_count,
          COALESCE(sum(candidate_bytes+commit_bytes),0)::bigint AS total_bytes,
          COALESCE(sum(candidate_bytes+commit_bytes) FILTER (WHERE owner_user_id=$1),0)::bigint AS owner_bytes
          FROM publication_tasks`,[profile.user_id])).rows[0];
        if (usage.total_count>=settings.maxTasks || usage.owner_count>=settings.maxTasksPerOwner ||
            Number(usage.total_bytes)+request.rawBody.length>settings.maxStoredBytes ||
            Number(usage.owner_bytes)+request.rawBody.length>settings.maxStoredBytesPerOwner) {
          throw taskError(429,'storage_limit','Publication task storage limit reached.');
        }
        const taskId = `pubtask_${randomUUID()}`, eventId = `pubevent_${randomUUID()}`;
        const task = (await client.query(`INSERT INTO publication_tasks
          (id,owner_user_id,request_key,request_hash,candidate_hash,candidate,candidate_bytes,state,intake_result,expires_at,purge_after,authority_kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,'delegated_pending',$8,now()+($9::bigint*interval '1 millisecond'),
            now()+($10::bigint*interval '1 millisecond'),'catsco') RETURNING expires_at`,
        [taskId,profile.user_id,request.idempotencyKey,requestHash,report.candidateHash,request.rawBody,request.rawBody.length,
          JSON.stringify(result),settings.candidateTtlMs,settings.retentionMs])).rows[0];
        await client.query(`INSERT INTO publication_delegations
          (task_id,issuer,audience,entry_request_id,candidate_revision,actor_uid,bot_uid,profile_id,namespace,delegation_id,authority_epoch,request_bytes)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11)`,
        [taskId,issuer,audience,grant.entryRequestId,grant.actorCatsCoUid,grant.botUid,profile.id,profile.namespace,grant.delegationId,grant.authorityEpoch,request.rawBody.length]);
        await client.query('INSERT INTO publication_delegation_outbox(task_id,event_id) VALUES($1,$2)',[taskId,eventId]);
        await live();
        return {created:true,accepted:true,association:receipt({task_id:taskId,entry_request_id:grant.entryRequestId,
          candidate_hash:report.candidateHash,request_hash:requestHash,authority_epoch:grant.authorityEpoch,
          event_id:eventId,candidate_bytes:request.rawBody.length,expires_at:task.expires_at,state:'delegated_pending'})};
      });
    } finally { active--; }
  };
}
