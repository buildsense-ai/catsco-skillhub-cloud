import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '../signing/index.js';
import {publicManifest} from '../domain/index.js';
import {validPublicationReceipt} from './receipt-client.js';
import {validPublicationPeerOrigin} from './introspection.js';
import {validPublicationCommitTarget,validPublicationCommitPermit,PublicationCommitPermitError} from './commit-permit-client.js';
import {publicationTaskSettings} from '../publication-tasks/config.js';
import {runPublishValidation} from '../publish-validation/runner.js';
import {runPreparePublication} from '../publication-tasks/prepare.js';
import {reservePublicVersion,lockPublicSkill} from '../publication-tasks/versions.js';
import {createPublicationCommitStore} from '../publication-tasks/commit-store.js';
import {processPublicationCommit} from '../publication-tasks/commit-worker.js';
import {delegatedValidationReport} from './validation-report.js';

const digest=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
export class DelegatedCommitError extends Error {
  constructor(kind='unavailable') {
    const kinds=['disabled','configuration','invalid','not_found','conflict','cancelled','publisher_changed',
      'confirmation_required','rejected','unavailable','busy','storage_limit'];
    if(!kinds.includes(kind))kind='unavailable';
    super('Delegated publication '+kind.replaceAll('_',' ')+'.');
    this.name='DelegatedCommitError';this.code='skillhub.delegated_commit_'+kind;
  }
}
const fail=kind=>{throw new DelegatedCommitError(kind);};

// INTERNAL only. The future CatsCo service adapter must authenticate publish
// intent before prepare; then persist/confirm its returned exact target in
// CatsCo. Neither prepare nor a caller boolean is a commit authorization.
export function createDelegatedPublicationCommitCoordinator({enabled=false,config,store,issuer,audience,permitClient}={}) {
  let settings;
  if(enabled===true) {
    if(!store?.tx || !store?.query || !validPublicationPeerOrigin(issuer) || !validPublicationPeerOrigin(audience) ||
      new URL(issuer).origin===new URL(audience).origin)fail('configuration');
    try {settings=publicationTaskSettings(config);}catch{fail('configuration');}
    if(!settings || config.publicationPublishing?.enabled!==true)fail('configuration');
  }
  let active=0;
  const run=async (receipt,fn)=>{
    if(enabled!==true)fail('disabled');
    if(!validPublicationReceipt(receipt))fail('invalid');
    if(active>=16)fail('busy');
    const r=Object.freeze({...receipt});active++;
    try{return await fn(r);}catch(e){
      if(e instanceof DelegatedCommitError || e instanceof PublicationCommitPermitError)throw e;
      // Stable public errors only; never retain SQL, private manifests or credentials.
      fail('unavailable');
    }finally{active--;}
  };
  const tx=fn=>store.tx(async c=>{
    await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("SET LOCAL statement_timeout='10s'");
    return fn(c);
  });
  const load=async(c,r,lock=false,historical=false)=>{
    if(lock)await c.query('SELECT id FROM publication_tasks WHERE id=$1 FOR UPDATE',[r.taskId]);
    // New statement after row lock: do not reuse a pre-wait joined snapshot.
    const row=(await c.query(
      `SELECT ${historical?'t.id,t.state,t.candidate_hash,t.error_code,t.publication_result':'t.*'},d.issuer,d.audience,d.actor_uid,d.profile_id,d.namespace,p.target,p.manifest,p.identity,p.receipt AS plan_receipt,`+
      ' proof.proof FROM publication_tasks t JOIN publication_delegations d ON d.task_id=t.id'+
      ' JOIN publication_delegation_outbox o ON o.task_id=t.id LEFT JOIN publication_delegated_plans p ON p.task_id=t.id'+
      ' LEFT JOIN publication_delegated_permits proof ON proof.task_id=t.id'+
      " WHERE t.id=$1 AND t.authority_kind='catsco' AND d.issuer=$2 AND d.audience=$3"+
      ' AND d.entry_request_id=$4 AND d.candidate_revision=$5 AND d.authority_epoch=$6'+
      ' AND t.request_hash=$7 AND t.candidate_hash=$8 AND d.request_bytes=$9 AND d.delegation_id=$10'+
      ' AND t.request_key=$11 AND o.event_id=$12',
      [r.taskId,issuer,audience,r.entryRequestId,r.candidateRevision,r.acceptanceEpoch,r.requestHash,r.sourceSnapshotHash,
        r.requestBytes,r.delegationId,r.idempotencyKey,r.eventId])).rows[0];
    if(!row)fail('not_found');
    if(row.state==='cancelled' && !historical)fail('cancelled');
    if(row.target && (!validPublicationCommitTarget(row.target) || !equal(row.plan_receipt,r) ||
      row.target.manifestHash!==digest(row.manifest) || row.target.candidateHash!==row.candidate_hash))fail('conflict');
    return row;
  };
  const authority=async(c,row)=>{
    if(!(await c.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE",[row.owner_user_id])).rowCount)fail('publisher_changed');
    const p=(await c.query("SELECT id,namespace,catsco_uid,catsco_issuer FROM publisher_profiles WHERE user_id=$1 AND status='active' FOR SHARE",[row.owner_user_id])).rows[0];
    if(!p || p.id!==row.profile_id || p.namespace!==row.namespace || p.catsco_uid!==row.actor_uid || p.catsco_issuer!==issuer)fail('publisher_changed');
  };
  const charge=async(c,id,owner)=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('skillhub-publication-task-intake')::bigint)");
    await c.query('UPDATE publication_tasks SET commit_bytes='+
      ' COALESCE((SELECT octet_length(to_jsonb(p)::text) FROM publication_delegated_plans p WHERE p.task_id=$1),0)'+
      '+COALESCE((SELECT octet_length(to_jsonb(p)::text) FROM publication_delegated_permits p WHERE p.task_id=$1),0)'+
      '+COALESCE((SELECT octet_length(to_jsonb(c)::text) FROM publication_commits c WHERE c.task_id=$1),0) WHERE id=$1',[id]);
    const usage=(await c.query('SELECT COALESCE(sum(candidate_bytes+commit_bytes),0)::bigint AS total,'+
      'COALESCE(sum(candidate_bytes+commit_bytes) FILTER (WHERE owner_user_id=$1),0)::bigint AS owned FROM publication_tasks',[owner])).rows[0];
    if(Number(usage.total)>settings.maxStoredBytes || Number(usage.owned)>settings.maxStoredBytesPerOwner)fail('storage_limit');
  };
  const view=row=>Object.freeze({schemaVersion:1,receipt:Object.freeze({...row.plan_receipt}),target:Object.freeze({...row.target})});
  return Object.freeze({
    // Initial validation of the immutable uploaded candidate, not final publish
    // status. This read never loads candidate bytes or touches plan/permit state.
    report(receipt) {
      return run(receipt,async r=>{
        const row=await tx(async c=>(await c.query(
          `SELECT t.intake_result FROM publication_tasks t JOIN publication_delegations d ON d.task_id=t.id
           JOIN publication_delegation_outbox o ON o.task_id=t.id
           WHERE t.id=$1 AND t.authority_kind='catsco' AND d.issuer=$2 AND d.audience=$3
             AND d.entry_request_id=$4 AND d.candidate_revision=$5 AND d.authority_epoch=$6
             AND t.request_hash=$7 AND t.candidate_hash=$8 AND d.request_bytes=$9
             AND d.delegation_id=$10 AND t.request_key=$11 AND o.event_id=$12`,
          [r.taskId,issuer,audience,r.entryRequestId,r.candidateRevision,r.acceptanceEpoch,r.requestHash,r.sourceSnapshotHash,
            r.requestBytes,r.delegationId,r.idempotencyKey,r.eventId])).rows[0]);
        if(!row)fail('not_found');
        return {schemaVersion:1,receipt:r,validation:delegatedValidationReport(row.intake_result,r.sourceSnapshotHash)};
      });
    },
    read(receipt) {
      return run(receipt,async r=>{
        const row=await tx(c=>load(c,r,false,true));
        if(!['delegated_pending','cancelled','committing','publish_queued','publish_failed','published'].includes(row.state))fail('conflict');
        if(row.proof && !validPublicationCommitPermit(row.proof,r,row.target))fail('conflict');
        const knownErrors=['owner_inactive','publisher_changed','prepared_changed','lease_lost','publish_unavailable',
          'publish_attempts_exhausted','final_validation_failed'].map(s=>'skillhub.publication_task_'+s);
        let result=null;
        if(row.state==='published') {
          const p=row.publication_result;
          if(!p || !row.target || p.skillId!==row.target.skillId || p.version!==row.target.version ||
            p.publishedAt!==row.target.releaseAt || !/^pkg_[a-f0-9-]{36}$/.test(p.packageId??'') ||
            !/^[a-f0-9]{64}$/.test(p.checksumSha256??''))fail('conflict');
          result=Object.fromEntries(['skillId','version','packageId','checksumSha256','publishedAt'].map(k=>[k,p[k]]));
        }
        return {schemaVersion:1,receipt:r,state:row.state,target:row.target??null,permitId:row.proof?.permitId??null,
          result,errorCode:row.error_code?(knownErrors.includes(row.error_code)?row.error_code:'skillhub.publication_task_publish_unavailable'):null};
      });
    },
    prepare(receipt,{confirmVersionPublish,signal}={}) {
      return run(receipt,async r=>{
        if(typeof confirmVersionPublish!=='boolean')fail('invalid');
        let row=await load(store,r);
        if(row.target) {
          await tx(async c=>{await authority(c,row);row=await load(c,r,true);});
          if(row.target.confirmVersionPublish!==confirmVersionPublish)fail('conflict');
          return view(row);
        }
        if(row.state!=='delegated_pending' || !row.candidate || new Date(row.expires_at)<=new Date())fail('conflict');
        const candidate=Buffer.from(row.candidate);
        const derived=await runPublishValidation({candidate,requestHash:row.request_hash,candidateHash:row.candidate_hash,namespace:row.namespace},
          settings.limits,{workerUrl:new URL('../publication-tasks/draft-worker.js',import.meta.url),
            timeoutMs:settings.execution.workerTimeoutMs,memoryMb:settings.execution.workerMemoryMb,signal});
        if(derived.status!==200)fail(derived.status>=500?'unavailable':'rejected');
        if(signal?.aborted)fail('unavailable');
        return tx(async c=>{
          await authority(c,row);row=await load(c,r,true);
          if(signal?.aborted)fail('unavailable');
          if(row.target) {
            if(row.target.confirmVersionPublish!==confirmVersionPublish)fail('conflict');
            return view(row);
          }
          if(row.state!=='delegated_pending' || !row.candidate || !row.candidate.equals(candidate) ||
            !(await c.query('SELECT $1::timestamptz>clock_timestamp() AS live',[row.expires_at])).rows[0].live)fail('conflict');
          const draft=publicManifest(derived.manifest);
          await lockPublicSkill(c,draft.id);
          const occupied=await c.query('SELECT 1 FROM skill_versions WHERE skill_id=$1 UNION ALL '+
            'SELECT 1 FROM publication_version_reservations WHERE skill_id=$1 UNION ALL '+
            "SELECT 1 FROM jobs WHERE type='publish_skill_version' AND payload->'manifest'->>'id'=$1 LIMIT 1",[draft.id]);
          if(occupied.rowCount && !confirmVersionPublish)fail('confirmation_required');
          const uploadId='upl_'+randomUUID();
          const reserved=await reservePublicVersion(c,{uploadId,skillId:draft.id,ownerId:row.owner_user_id,version:draft.version});
          const identity={ownerId:row.owner_user_id,uploadId,skillId:draft.id,version:reserved.version,releaseAt:new Date().toISOString()};
          const skillHub={author:row.namespace,version:identity.version,uploadedAt:identity.releaseAt};
          const manifest={...draft,version:identity.version,skillHub,skillhub_author:skillHub.author,
            skillhub_version:skillHub.version,skillhub_uploaded_at:skillHub.uploadedAt};
          const target={candidateHash:row.candidate_hash,manifestHash:digest(manifest),publisherUserId:row.owner_user_id,
            publisherProfileId:row.profile_id,namespace:row.namespace,skillId:draft.id,version:identity.version,
            uploadId,releaseAt:identity.releaseAt,confirmVersionPublish};
          if(!validPublicationCommitTarget(target))fail('invalid');
          await c.query('INSERT INTO publication_delegated_plans(task_id,receipt,target,manifest,identity) VALUES($1,$2,$3,$4,$5)',
            [r.taskId,JSON.stringify(r),JSON.stringify(target),JSON.stringify(manifest),JSON.stringify(identity)]);
          await charge(c,r.taskId,row.owner_user_id);
          return view({target,plan_receipt:r});
        });
      });
    },
    authorize(receipt,{signal}={}) {
      return run(receipt,async r=>{
        let row=await load(store,r);
        if(!row.target)fail('conflict');
        // Recover the Cloud boundary itself without asking CatsCo for new
        // authority, rerunning preparation or requeueing exhausted work.
        if(row.proof) {
          if(!validPublicationCommitPermit(row.proof,r,row.target))fail('conflict');
          return {state:row.state,permitId:row.proof.permitId,replayed:true};
        }
        if(row.state!=='delegated_pending' || !row.candidate || !permitClient?.authorize)fail('conflict');
        await tx(c=>authority(c,row));
        const prepared=await runPreparePublication({rawJson:row.candidate,requestHash:row.request_hash,
          candidateHash:row.candidate_hash,manifest:row.manifest,identity:row.identity},settings.limits,
          {timeoutMs:settings.execution.workerTimeoutMs,memoryMb:settings.execution.workerMemoryMb,signal});
        if(prepared.status!==200)fail(prepared.status>=500?'unavailable':'rejected');
        if(!equal(prepared.prepared.manifest,row.manifest))fail('conflict');
        if(signal?.aborted)fail('unavailable');
        // Deliberately OUTSIDE all SQL transactions. A timeout may have issued
        // the permit; retry the same frozen facts, never allocate another plan.
        const permit=await permitClient.authorize(view(row),{signal});
        if(!validPublicationCommitPermit(permit,r,row.target))fail('conflict');
        const proof=structuredClone(permit);
        if(signal?.aborted)fail('unavailable');
        return tx(async c=>{
          await authority(c,row);row=await load(c,r,true);
          if(row.proof) {
            if(!equal(row.proof,proof))fail('conflict');
            return {state:row.state,permitId:row.proof.permitId,replayed:true};
          }
          if(row.state!=='delegated_pending'||!row.candidate||!equal(row.target,proof.target)||signal?.aborted)fail('conflict');
          await c.query('INSERT INTO publication_delegated_permits(task_id,permit_id,proof) VALUES($1,$2,$3)',
            [r.taskId,proof.permitId,JSON.stringify(proof)]);
          await c.query('INSERT INTO publication_commits(task_id,profile_id,namespace,confirm_version,manifest,identity,'+
            'scan_id,package_id,receipt,delegated_permit_task) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$1)',
            [r.taskId,row.profile_id,row.namespace,row.target.confirmVersionPublish,JSON.stringify(row.manifest),JSON.stringify(row.identity),
              'scan_'+randomUUID(),'pkg_'+randomUUID(),JSON.stringify(prepared.prepared.receipt)]);
          await charge(c,r.taskId,row.owner_user_id);
          await c.query("UPDATE publication_tasks SET state='committing',run_after=clock_timestamp(),error_code=NULL,updated_at=clock_timestamp() WHERE id=$1",[r.taskId]);
          return {state:'committing',permitId:proof.permitId,replayed:false};
        });
      });
    }
  });
}

// Internal worker entry. The separately gated delegated scheduler calls this;
// the ordinary worker factory remains account-only.
export function processDelegatedPublicationCommit(config,{enabled=false,store,...dependencies}={}) {
  if(enabled!==true)return Promise.resolve(null);
  if(!store?.tx || !store?.query)return Promise.reject(new DelegatedCommitError('configuration'));
  return processPublicationCommit(config,{...dependencies,store:{
    ...store,...createPublicationCommitStore({query:store.query,tx:store.tx,config,delegated:true})
  }});
}

