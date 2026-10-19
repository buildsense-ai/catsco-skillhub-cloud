// Real Cloud intake/PG fixture; the synthetic introspection observation is
// explicit. Cross-repo tests replace this with the actual CatsCo peer client.
import {randomUUID,createHash} from 'node:crypto';
import {createDelegatedPublicationIntake} from '../../packages/publication-delegation/intake.js';
import {validatePublishRequest} from '../../packages/publish-validation/index.js';
export const id=()=>randomUUID().replaceAll('-','');
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const delegatedSource=(files=[])=>Buffer.from(JSON.stringify({source:{type:'files',files:[{path:'SKILL.md',
  content:'---\nname: commit-test\ndescription: Fixture only\n---\nPrivate source\n'},...files]}}));
export async function delegatedFixture(store,config,{issuer='https://commit.invalid',audience='https://cloud.invalid',
  actor=String(BigInt('0x'+id().slice(0,12))+1000n),files=[],grant,introspectionClient}={}) {
  const suffix=id();
  const identity=await store.claimCatsCoPublisherIdentity({catsCoUid:actor,catsCoIssuer:issuer,
    namespace:`delegated-${suffix}`,displayName:'Commit fixture',contact:'',
    internalEmail:`${suffix}@example.invalid`,passwordHash:'fixture'});
  const rawBody=delegatedSource(files);
  const input={rawBody,sourceSnapshotHash:validatePublishRequest(rawBody.toString()).body.validation.candidateHash,
    entryRequestId:`pubentry_${id()}`,token:`pubupload_${id()+id()}`,idempotencyKey:`pubcandidate_${id()}`,authorityEpoch:1,...grant};
  const accept=createDelegatedPublicationIntake({enabled:true,config,store,issuer,audience,
    introspectionClient:introspectionClient??{async checkUploadGrant(r) {
      return {issuer,audience,action:'candidate.upload',actorCatsCoUid:actor,botUid:'999',
        entryRequestId:r.entryRequestId,candidateRevision:1,authorityEpoch:r.authorityEpoch,
        requestHash:hash(r.rawBody),requestBytes:r.rawBody.length,sourceSnapshotHash:r.sourceSnapshotHash,
        idempotencyKey:r.idempotencyKey,delegationId:r.entryRequestId.replace('pubentry_','pubgrant_'),
        observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90000).toISOString()};
    }}});
  const {association}=await accept(input);
  const receipt={schemaVersion:1,entryRequestId:input.entryRequestId,candidateRevision:1,acceptanceEpoch:1,
    requestHash:hash(rawBody),sourceSnapshotHash:input.sourceSnapshotHash,requestBytes:rawBody.length,
    delegationId:association.delegationId??input.entryRequestId.replace('pubentry_','pubgrant_'),
    idempotencyKey:input.idempotencyKey,taskId:association.taskId,eventId:association.eventId};
  // Read the actual immutable association, never infer peer-issued grant IDs.
  receipt.delegationId=(await store.query('SELECT delegation_id FROM publication_delegations WHERE task_id=$1',[receipt.taskId])).rows[0].delegation_id;
  return {owner:identity.user.id,profile:identity.developerProfile,input,accept,receipt,issuer,audience};
}
export async function cleanupDelegatedFixture(store,f) {
  const owner=f.owner;
  for(const table of ['publication_commits','publication_delegated_permits','publication_delegated_plans','publication_delegations'])
    await store.query(`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM publication_tasks WHERE owner_user_id=$1)`,[owner]);
  await store.query('DELETE FROM publication_tasks WHERE owner_user_id=$1',[owner]);
  await store.query('DELETE FROM publication_version_reservations WHERE owner_user_id=$1',[owner]);
  await store.query('DELETE FROM skill_scans WHERE skill_id IN (SELECT skill_id FROM skill_versions WHERE owner_user_id=$1)',[owner]);
  await store.query('DELETE FROM skill_versions WHERE owner_user_id=$1',[owner]);
  await store.query('DELETE FROM skills WHERE owner_user_id=$1',[owner]);
  await store.query('DELETE FROM users WHERE id=$1',[owner]);
}
