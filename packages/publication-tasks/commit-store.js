import { randomUUID } from 'node:crypto';
import { slugify } from '../domain/index.js';
import { canonicalJson } from '../signing/index.js';
import { lockPublicSkill, reservePublicVersion } from './versions.js';
import { taskError, publicTask } from './store.js';
import { publicationTaskSettings } from './config.js';

const MAX_ATTEMPTS = 3;
const privateSelect = `SELECT t.*, t.expires_at>now() AS candidate_live, to_jsonb(c) AS intent FROM publication_tasks t
  LEFT JOIN publication_commits c ON c.task_id=t.id`;
const lost = () => taskError(409,'lease_lost','Publication work is no longer owned by this worker.');

async function authority(client, ownerId, expected) {
  const user = (await client.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE",[ownerId])).rows[0];
  if (!user) throw taskError(403,'owner_inactive','Publication owner is unavailable.');
  const profile = (await client.query("SELECT id,namespace FROM publisher_profiles WHERE user_id=$1 AND status='active' FOR SHARE",[ownerId])).rows[0];
  if (!profile || (expected && (profile.id !== expected.profile_id || profile.namespace !== expected.namespace))) {
    throw taskError(403,'publisher_changed','Publisher identity is unavailable or has changed.');
  }
  return profile;
}

async function ownedLease(client, task) {
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='10s'");
  await authority(client,task.owner_user_id,task.intent);
  await client.query('SELECT id FROM publication_tasks WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[task.id,task.owner_user_id]);
  const row = (await client.query(`${privateSelect} WHERE t.id=$1 AND t.owner_user_id=$2
    AND t.lease_token=$3 AND t.lease_until>clock_timestamp()
    AND t.state IN ('publishing','committing') FOR UPDATE OF t`,[task.id,task.owner_user_id,task.lease_token])).rows[0];
  if (!row) throw lost();
  return row;
}

export function createPublicationCommitStore({ query, tx, config }) {
  async function charge(client,id,ownerId) {
    const settings=publicationTaskSettings(config);
    if (!settings) throw taskError(503,'unavailable','Publication storage is unavailable.');
    // Use the intake quota lock: private checkpoints count against the same
    // per-owner/global storage budgets as candidate bytes.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('skillhub-publication-task-intake')::bigint)");
    await client.query(`UPDATE publication_tasks SET commit_bytes=octet_length(
      (SELECT to_jsonb(c)::text FROM publication_commits c WHERE c.task_id=$1)) WHERE id=$1`,[id]);
    const usage=(await client.query(`SELECT COALESCE(sum(candidate_bytes+commit_bytes),0)::bigint AS total,
      COALESCE(sum(candidate_bytes+commit_bytes) FILTER (WHERE owner_user_id=$1),0)::bigint AS owned FROM publication_tasks`,[ownerId])).rows[0];
    if (Number(usage.total)>settings.maxStoredBytes || Number(usage.owned)>settings.maxStoredBytesPerOwner) {
      throw taskError(429,'storage_limit','Publication task storage limit reached.');
    }
  }
  const transaction = fn => tx(async client => {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    return fn(client);
  });
  return {
    async getPublicationRequest(ownerId,id) {
      return (await query(`${privateSelect} WHERE t.id=$1 AND t.owner_user_id=$2`,[id,ownerId])).rows[0] ?? null;
    },
    async enqueuePublicationCommit({ ownerId,id,candidateHash,confirmVersionPublish,manifest,profile }) {
      return transaction(async client => {
        const currentProfile = await authority(client,ownerId,profile ? {profile_id:profile.id,namespace:profile.namespace} : null);
        // Lock separately, then take a NEW READ COMMITTED snapshot. A joined
        // SELECT waiting on t can otherwise return new t but stale/null c.
        await client.query('SELECT id FROM publication_tasks WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,ownerId]);
        const row = (await client.query(`${privateSelect} WHERE t.id=$1 AND t.owner_user_id=$2 FOR UPDATE OF t`,[id,ownerId])).rows[0];
        if (!row) throw taskError(404,'not_found','Publication task was not found.');
        if (row.candidate_hash !== candidateHash) throw taskError(409,'candidate_changed','Publication candidate changed.');
        if (row.intent) {
          if (row.intent.confirm_version !== confirmVersionPublish) throw taskError(409,'request_conflict','Publication confirmation differs from the accepted request.');
          await authority(client,ownerId,row.intent);
          if (row.state === 'publish_failed' && row.candidate) {
            await client.query("UPDATE publication_commits SET attempts=0 WHERE task_id=$1",[id]);
            const resumed = await client.query(`UPDATE publication_tasks SET state='publish_queued',error_code=NULL,
              run_after=now(),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[id]);
            return {task:publicTask({...resumed.rows[0],intent:row.intent}),replayed:true};
          }
          return {task:publicTask(row),replayed:true};
        }
        if (row.state !== 'ready' || !row.candidate_live || !row.candidate) {
          throw taskError(409,'not_ready','Only a live, validated candidate can be published.');
        }
        if (!manifest || manifest.id !== `${slugify(currentProfile.namespace,'user')}/${manifest.name}`) {
          throw taskError(409,'publisher_changed','Publication manifest does not match the publisher.');
        }
        await lockPublicSkill(client,manifest.id);
        const occupied = await client.query(`SELECT 1 FROM skill_versions WHERE skill_id=$1
          UNION ALL SELECT 1 FROM publication_version_reservations WHERE skill_id=$1
          UNION ALL SELECT 1 FROM jobs WHERE type='publish_skill_version' AND payload->'manifest'->>'id'=$1 LIMIT 1`,[manifest.id]);
        if (occupied.rowCount && !confirmVersionPublish) throw taskError(409,'confirmation_required','Confirm publication of a new Skill version.');
        const uploadId = `upl_${randomUUID()}`;
        const reservation = await reservePublicVersion(client,{uploadId,skillId:manifest.id,ownerId,version:manifest.version});
        const identity = {ownerId,uploadId,skillId:manifest.id,version:reservation.version,releaseAt:new Date().toISOString()};
        await client.query(`INSERT INTO publication_commits
          (task_id,profile_id,namespace,confirm_version,manifest,identity,scan_id,package_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,currentProfile.id,currentProfile.namespace,confirmVersionPublish,
          JSON.stringify({...manifest,version:reservation.version}),JSON.stringify(identity),`scan_${randomUUID()}`,`pkg_${randomUUID()}`]);
        await charge(client,id,ownerId);
        const accepted = await client.query(`UPDATE publication_tasks SET state='publish_queued',error_code=NULL,
          run_after=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id]);
        return {task:publicTask({...accepted.rows[0],publication_accepted:true}),replayed:false};
      });
    },
    async claimPublicationCommit(settings) {
      return transaction(async client => {
        await client.query(`UPDATE publication_tasks SET state='publish_failed',error_code='skillhub.publication_task_publish_attempts_exhausted',
          lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id IN
          (SELECT t.id FROM publication_tasks t JOIN publication_commits c ON c.task_id=t.id
           WHERE t.state IN ('publishing','committing') AND t.lease_until<=now() AND c.attempts>=$1
           LIMIT 100 FOR UPDATE OF t SKIP LOCKED)`,[MAX_ATTEMPTS]);
        const selected = (await client.query(`${privateSelect} WHERE c.attempts<$1 AND t.candidate IS NOT NULL
          AND ((t.state='publish_queued' AND t.run_after<=now()) OR (t.state IN ('publishing','committing') AND t.lease_until<=now()))
          ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`,[MAX_ATTEMPTS])).rows[0];
        if (!selected) return null;
        const row=(await client.query(`${privateSelect} WHERE t.id=$1`,[selected.id])).rows[0];
        await client.query('UPDATE publication_commits SET attempts=attempts+1 WHERE task_id=$1',[row.id]);
        const claimed = (await client.query(`UPDATE publication_tasks SET state=CASE WHEN $4 THEN 'committing' ELSE 'publishing' END,
          lease_token=$2,lease_until=now()+($3::bigint*interval '1 millisecond'),updated_at=now()
          WHERE id=$1 RETURNING *`,[row.id,randomUUID(),settings.leaseMs,Boolean(row.intent.receipt)])).rows[0];
        return {...claimed,intent:{...row.intent,attempts:row.intent.attempts+1}};
      });
    },
    async renewPublicationCommit(task,settings) {
      const result = await query(`UPDATE publication_tasks SET lease_until=now()+($3::bigint*interval '1 millisecond')
        WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND state IN ('publishing','committing')`,
      [task.id,task.lease_token,settings.leaseMs]);
      return result.rowCount===1;
    },
    async beginPublicationCommit(task,receipt,validationResult=null) {
      return transaction(async client => {
        const row = await ownedLease(client,task);
        if (receipt.candidateHash!==row.candidate_hash || receipt.requestHash!==row.request_hash ||
          canonicalJson(receipt.identity)!==canonicalJson(row.intent.identity) ||
          (row.intent.receipt && canonicalJson(row.intent.receipt)!==canonicalJson(receipt))) {
          throw taskError(409,'prepared_changed','Prepared publication no longer matches the accepted candidate.');
        }
        await client.query('UPDATE publication_commits SET receipt=$2 WHERE task_id=$1',[task.id,JSON.stringify(receipt)]);
        await charge(client,task.id,task.owner_user_id);
        const updated=await client.query(`UPDATE publication_tasks SET state='committing',error_code=NULL,
          validation_result=COALESCE($3,validation_result),updated_at=now()
          WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
        [task.id,task.lease_token,validationResult?JSON.stringify(validationResult):null]);
        if (!updated.rowCount) throw lost();
      });
    },
    async checkpointPublicationCommit(task,checkpoint) {
      return transaction(async client => {
        const row = await ownedLease(client,task);
        if (row.state!=='committing' || !row.intent.receipt) throw lost();
        if (row.intent.checkpoint) return row.intent.checkpoint;
        const {packageVersion:p,scanRun:s}=checkpoint, i=row.intent.identity;
        if (p.id!==row.intent.package_id || s.id!==row.intent.scan_id || p.submissionId!==i.uploadId ||
          p.skillId!==i.skillId || p.version!==i.version || p.publishedAt!==i.releaseAt) throw lost();
        await client.query('UPDATE publication_commits SET checkpoint=$2 WHERE task_id=$1',[task.id,JSON.stringify(checkpoint)]);
        await charge(client,task.id,task.owner_user_id);
        const live=await client.query('SELECT id FROM publication_tasks WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()',[task.id,task.lease_token]);
        if (!live.rowCount) throw lost();
        return checkpoint;
      });
    },
    async failPublicationCommit(task,{errorCode='skillhub.publication_task_publish_unavailable',result=null,retry=false}={}) {
      return transaction(async client => {
        // Do not require active authority to close a now-revoked attempt.
        await client.query('SELECT id FROM publication_tasks WHERE id=$1 FOR UPDATE',[task.id]);
        const row = (await client.query(`${privateSelect} WHERE t.id=$1 AND t.lease_token=$2
          AND t.lease_until>clock_timestamp() AND t.state IN ('publishing','committing') FOR UPDATE OF t`,[task.id,task.lease_token])).rows[0];
        if (!row) return false;
        const state = retry && row.intent.attempts<MAX_ATTEMPTS ? 'publish_queued' : 'publish_failed';
        await client.query(`UPDATE publication_tasks SET state=$3,error_code=$4,validation_result=COALESCE($5,validation_result),
          lease_token=NULL,lease_until=NULL,run_after=now()+interval '5 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [task.id,task.lease_token,state,errorCode,result?JSON.stringify(result):null]);
        return true;
      });
    }
  };
}

// Called inside the same transaction that inserts skill_versions. No file IO.
export async function lockPublicationCompletion(client,task,packageVersion,submission) {
  const row=await ownedLease(client,task);
  if (row.state!=='committing' || !row.intent.checkpoint ||
    canonicalJson(row.intent.checkpoint.packageVersion)!==canonicalJson(packageVersion) ||
    submission.id!==row.intent.identity.uploadId || submission.submitterId!==row.owner_user_id) throw lost();
  return row;
}

export async function finishPublicationCompletion(client,row,p,retentionMs) {
  const s=row.intent.checkpoint.scanRun;
  await client.query(`INSERT INTO skill_scans (id,skill_id,version,upload_id,status,risk_level,summary,findings,inventory,scanner_version,started_at,finished_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[s.id,s.skillId,s.version,s.uploadId,s.status,s.riskLevel,
    JSON.stringify(s.summary),JSON.stringify(s.findings),JSON.stringify(s.inventory),s.scannerVersion,s.startedAt,s.finishedAt]);
  const result = await client.query(`UPDATE publication_tasks SET state='published',publication_result=$3,
    purge_after=GREATEST(purge_after,now()+($4::bigint*interval '1 millisecond')),
    candidate=NULL,candidate_bytes=0,lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,[row.id,row.lease_token,JSON.stringify({
    skillId:p.skillId,version:p.version,packageId:p.id,checksumSha256:p.checksumSha256,publishedAt:p.publishedAt}),retentionMs]);
  if (!result.rowCount) throw lost();
}
