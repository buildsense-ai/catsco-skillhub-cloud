import assert from 'node:assert/strict';
import {test,before,after,afterEach} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,closePools} from '../../packages/database/store.js';
import {loadConfig} from '../../packages/config/index.js';
import {createApiServer} from '../../apps/api/server.js';
import {hashSessionToken} from '../../packages/auth/index.js';
import {validatePublishRequest} from '../../packages/publish-validation/index.js';
import {publicationTaskSettings} from '../../packages/publication-tasks/config.js';
import {processPublicationCommit} from '../../packages/publication-tasks/commit-worker.js';
import {publicTask} from '../../packages/publication-tasks/store.js';
import {runPreparePublication} from '../../packages/publication-tasks/prepare.js';
import {issueSigningKeyCertificate} from '../../packages/signing/index.js';
import {commitGitVersion} from '../../packages/git-storage/index.js';

const databaseUrl=process.env.SKILLHUB_TEST_DATABASE_URL, pg={skip:!databaseUrl};
const hash=value=>createHash('sha256').update(value).digest('hex');
let root,config,store,settings;
const owners=[];
before(async()=>{
  if (!databaseUrl) return;
  root=await fs.mkdtemp(path.join(os.tmpdir(),'skillhub-commits-'));
  config=loadConfig({root,databaseUrl,nodeEnv:'test',publicationTasksEnabled:true,publicationPublishingEnabled:true,
    allowAutoKeygen:true,sessionSecret:'commit-tests'});
  store=createStore(config); settings=publicationTaskSettings(config);
  await issueSigningKeyCertificate(config);
});
afterEach(async()=>{
  if (!store) return;
  for (const ownerId of owners.splice(0)) {
    await store.query('DELETE FROM publication_tasks WHERE owner_user_id=$1',[ownerId]);
    await store.query('DELETE FROM publication_version_reservations WHERE owner_user_id=$1',[ownerId]);
    await store.query('DELETE FROM skill_scans WHERE skill_id IN (SELECT skill_id FROM skill_versions WHERE owner_user_id=$1)',[ownerId]);
    await store.query('DELETE FROM skill_scans WHERE skill_id=$1',[`${ownerId}/sample`]);
    await store.query('DELETE FROM skill_versions WHERE owner_user_id=$1',[ownerId]);
    await store.query('DELETE FROM skills WHERE owner_user_id=$1',[ownerId]);
    await store.query('DELETE FROM users WHERE id=$1',[ownerId]);
  }
});
after(async()=>{await closePools();if(root) await fs.rm(root,{recursive:true,force:true});});

async function fixture() {
  const ownerId=`commit-${randomUUID()}`; owners.push(ownerId);
  await store.query("INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'test',$1)",[ownerId,`${ownerId}@example.invalid`]);
  const profile=await store.ensureDeveloperProfile({userId:ownerId,namespace:ownerId,displayName:'Publisher',contact:''});
  const f={ownerId,profile,skillId:`${ownerId}/sample`};
  f.manifest={id:f.skillId,name:'sample',displayName:'Sample',description:'Useful',version:'1.0.0',entrypoints:{skillFile:'SKILL.md'}};
  return f;
}
async function ready(f,suffix='') {
  const candidate=Buffer.from(JSON.stringify({source:{type:'files',files:[{path:'SKILL.md',
    content:`---\nname: sample\ndescription: Useful\n---\nPrivate instructions ${suffix}\n`}]}}));
  const result=validatePublishRequest(candidate.toString());
  const saved=await store.createPublicationTask({ownerId:f.ownerId,requestKey:`key-${randomUUID()}`,requestHash:hash(candidate),
    candidateHash:result.body.validation.candidateHash,candidate,result,settings});
  await store.query("UPDATE publication_tasks SET state='ready',validation_result=$2 WHERE id=$1",[saved.task.id,JSON.stringify(result)]);
  return {...f,id:saved.task.id,candidateHash:result.body.validation.candidateHash};
}
const enqueue=(f,confirmVersionPublish=false)=>store.enqueuePublicationCommit({...f,confirmVersionPublish});
const due=f=>store.query("UPDATE publication_tasks SET run_after=now()-interval '1 second' WHERE id=$1",[f.id]);
const countVersions=f=>store.query('SELECT * FROM skill_versions WHERE skill_id=$1',[f.skillId]);
async function withApi(f,callback,extra={}) {
  const apiStore={...store,getSessionByTokenHash:async value=>value===hashSessionToken('owner','commit-tests')?{userId:f.ownerId}:null};
  const server=createApiServer({...config,...extra},{store:apiStore});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const req=async(route,body,auth=true)=>{
    const r=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',
      ...(auth?{cookie:'catsco_session=owner'}:{authorization:'Bearer not-a-session'})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  try {await callback(req);} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('publication is separately default-off and does not reinterpret completed tasks as expired',async()=>{
  assert.equal(loadConfig({nodeEnv:'production'}).publicationPublishing.enabled,false);
  assert.equal(await processPublicationCommit(loadConfig(),{store:{claimPublicationCommit(){throw new Error();}}}),null);
  const row={id:'test',state:'published',publication_result:{skillId:'a/b',version:'1.0.0'},candidate_bytes:0,
    created_at:0,updated_at:0,expires_at:1,purge_after:2};
  assert.equal(publicTask(row).state,'published');
  assert.equal(publicTask({...row,state:'committing',commit_started:true}).state,'committing');
  assert.equal(publicTask({...row,state:'ready',publication_result:null}).state,'expired');
});

test('publication Git abort closes its writer and a later attempt can acquire the repository lock',async()=>{
  const localRoot=await fs.mkdtemp(path.join(os.tmpdir(),'skillhub-abort-'));
  try {
    const localConfig=loadConfig({root:localRoot,nodeEnv:'test'});
    const controller=new AbortController();controller.abort();
    const args={config:localConfig,scope:'public',skillId:'abort/sample',version:'1.0.0',
      files:[{path:'SKILL.md',content:'sample'}],createdAt:'2026-10-14T00:00:00.000Z'};
    await assert.rejects(commitGitVersion({...args,signal:controller.signal}),{name:'AbortError'});
    assert.ok((await commitGitVersion(args)).commitSha);
  } finally {await fs.rm(localRoot,{recursive:true,force:true});}
});

test('PostgreSQL HTTP publish authenticates, derives namespace, is idempotent, and returns actual durable publication',pg,async()=>{
  const f=await ready(await fixture());
  await withApi(f,async req=>{
    const route=`/api/skills/publication-tasks/${f.id}/publish`,body={candidateHash:f.candidateHash,confirmVersionPublish:false};
    assert.equal((await req(route,body,false)).status,401);
    assert.equal((await req(route,{...body,ownerId:'other'})).status,400);
    assert.equal((await req(route,{...body,candidateHash:'a'.repeat(64)})).status,409);
    const accepted=await req(route,body); assert.equal(accepted.status,202);assert.equal(accepted.body.task.state,'publish_queued');
    const replay=await req(route,body);assert.equal(replay.body.replayed,true);
    await processPublicationCommit(config,{store});
    const published=await req(route,body);
    assert.equal(published.status,200,JSON.stringify(published.body));
    assert.equal(published.body.task.state,'published');
    assert.equal(published.body.task.publication.skillId,f.skillId);
    assert.equal(JSON.stringify(published.body).includes('Private instructions'),false);
    assert.equal(JSON.stringify(published.body).includes('lease_token'),false);
    assert.equal((await countVersions(f)).rowCount,1);
    assert.equal((await req('/api/skills/share',{source:{type:'files',files:[]}})).body.error.code,'skillhub.publication_task_required');
  });
});

test('PostgreSQL publish gate leaves old route compatibility and new endpoint disabled when switched off',pg,async()=>{
  const f=await ready(await fixture());
  await withApi(f,async req=>{
    assert.equal((await req(`/api/skills/publication-tasks/${f.id}/publish`,{candidateHash:f.candidateHash,confirmVersionPublish:false})).status,404);
  },{publicationPublishing:{enabled:false}});
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'ready');
});

test('PostgreSQL concurrent acceptance reserves one identity; further versions require confirmation',pg,async()=>{
  const f=await ready(await fixture());
  const results=await Promise.all(Array.from({length:8},()=>enqueue(f)));
  assert.equal(results.filter(r=>!r.replayed).length,1);
  assert.equal((await store.query('SELECT * FROM publication_version_reservations WHERE owner_user_id=$1',[f.ownerId])).rowCount,1);
  const other=await ready(f,'new');
  await assert.rejects(enqueue(other),{code:'skillhub.publication_task_confirmation_required'});
  await enqueue(other,true);
  const a=await store.getPublicationRequest(f.ownerId,f.id),b=await store.getPublicationRequest(f.ownerId,other.id);
  assert.equal(a.intent.identity.version,'1.0.0');assert.equal(b.intent.identity.version,'1.0.1');
  await assert.rejects(enqueue(f,true),{code:'skillhub.publication_task_request_conflict'});
});

for (const point of ['afterGit','afterArtifact','beforeComplete']) test(`PostgreSQL recovery after ${point} retains exact version and one final result`,pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);
  let first;
  await processPublicationCommit(config,{store,[point]:async(task)=>{
    first=task.intent.identity;
    // A process dying cannot release its lease. Force expiry to emulate death.
    await store.query("UPDATE publication_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[f.id]);
    throw new Error('simulated process loss');
  }});
  assert.equal((await countVersions(f)).rowCount,0);
  const interrupted=await store.getPublicationRequest(f.ownerId,f.id);
  assert.equal(interrupted.state,'committing');
  await assert.rejects(store.cancelPublicationTask(f.ownerId,f.id),{code:'skillhub.publication_task_commit_started'});
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '2 days',purge_after=now()-interval '1 day' WHERE id=$1",[f.id]);
  await store.maintainPublicationTasks();
  assert.ok((await store.getPublicationRequest(f.ownerId,f.id)).candidate);
  await processPublicationCommit(config,{store});
  const completed=await store.getPublicationRequest(f.ownerId,f.id);
  assert.equal(completed.state,'published',JSON.stringify(publicTask(completed)));
  assert.deepEqual(completed.intent.identity,first);
  assert.equal(completed.candidate,null);
  assert.equal((await countVersions(f)).rowCount,1);
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'published');
  await store.maintainPublicationTasks();
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'published');
  await enqueue(f);
  assert.equal(await processPublicationCommit(config,{store}),null);
});

test('PostgreSQL cancellation before commit prevents Git; reclaimed workers cannot cross the commit fence',pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);
  const old=await store.claimPublicationCommit(settings);
  const prepared=await runPreparePublication({rawJson:old.candidate,requestHash:old.request_hash,candidateHash:old.candidate_hash,
    manifest:old.intent.manifest,identity:old.intent.identity},settings.limits);
  await store.query("UPDATE publication_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[f.id]);
  const fresh=await store.claimPublicationCommit(settings);
  assert.notEqual(fresh.lease_token,old.lease_token);
  await assert.rejects(store.beginPublicationCommit(old,prepared.prepared.receipt),{code:'skillhub.publication_task_lease_lost'});
  await store.cancelPublicationTask(f.ownerId,f.id);
  await assert.rejects(store.beginPublicationCommit(fresh,prepared.prepared.receipt),{code:'skillhub.publication_task_lease_lost'});
  assert.equal((await countVersions(f)).rowCount,0);
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'cancelled');
});

test('PostgreSQL package insertion rolls back with completion failure, then resumes original checkpoint',pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);
  let checkpoint;
  await processPublicationCommit(config,{store,beforeComplete:async(_task,c)=>{checkpoint=c;await store.saveSkillScan(c.scanRun);}});
  assert.ok(checkpoint);
  assert.equal((await countVersions(f)).rowCount,0);
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'publish_queued');
  await store.query('DELETE FROM skill_scans WHERE id=$1',[checkpoint.scanRun.id]);await due(f);
  await processPublicationCommit(config,{store});
  const p=(await countVersions(f)).rows[0];
  assert.equal(p.checksum_sha256,checkpoint.packageVersion.checksumSha256);
  assert.equal(p.id,checkpoint.packageVersion.id);
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).publication.packageId,p.id);
});

test('PostgreSQL publisher changes during commit prevent publication and explicit retry rechecks authority',pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);
  await processPublicationCommit(config,{store,beforeComplete:async()=>{
    await store.query("UPDATE publisher_profiles SET namespace=namespace||'-changed' WHERE user_id=$1",[f.ownerId]);
  }});
  assert.equal((await countVersions(f)).rowCount,0);
  const failed=await store.getPublicationTask(f.ownerId,f.id);
  assert.equal(failed.state,'publish_failed');assert.equal(failed.errorCode,'skillhub.publication_task_publisher_changed');
  await assert.rejects(enqueue(f),{code:'skillhub.publication_task_publisher_changed'});
  await store.query('UPDATE publisher_profiles SET namespace=$2 WHERE user_id=$1',[f.ownerId,f.profile.namespace]);
  await enqueue(f);await processPublicationCommit(config,{store});
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'published');
});

test('PostgreSQL new versions preserve private visibility and legacy store cannot bypass task completion',pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);await processPublicationCommit(config,{store});
  await store.query("UPDATE skills SET visibility_scope='private' WHERE id=$1",[f.skillId]);
  const next=await ready(f,'next');await enqueue(next,true);
  await processPublicationCommit(config,{store,beforeComplete:async(task,c)=>{
    await assert.rejects(store.createPackageVersion(c.packageVersion,{id:task.intent.identity.uploadId,submitterId:f.ownerId}),
      {code:'skillhub.publication_version_conflict'});
  }});
  assert.equal((await store.query('SELECT visibility_scope FROM skills WHERE id=$1',[f.skillId])).rows[0].visibility_scope,'private');
  assert.equal((await store.getPublicationTask(f.ownerId,next.id)).state,'published');
});

test('PostgreSQL private intent metadata participates in the candidate storage quota atomically',pg,async()=>{
  const f=await ready(await fixture());
  const lowConfig={...config,publicationTasks:{...config.publicationTasks,maxStoredBytesPerOwner:400}};
  const limited=createStore(lowConfig);
  await assert.rejects(limited.enqueuePublicationCommit({...f,confirmVersionPublish:false}),{code:'skillhub.publication_task_storage_limit'});
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).state,'ready');
  assert.equal((await store.query('SELECT * FROM publication_version_reservations WHERE owner_user_id=$1',[f.ownerId])).rowCount,0);
});

test('PostgreSQL a different account cannot publish another task, including accepted intents',pg,async()=>{
  const f=await ready(await fixture()),other=await fixture();
  for (const accepted of [false,true]) {
    if (accepted) await enqueue(f);
    await withApi(other,async req=>{
      const response=await req(`/api/skills/publication-tasks/${f.id}/publish`,{candidateHash:f.candidateHash,confirmVersionPublish:false});
      assert.equal(response.status,404);assert.equal(JSON.stringify(response.body).includes(f.candidateHash),false);
    });
  }
});

test('PostgreSQL deactivated publisher and changed bytes fail before Git, without leaking the private candidate',pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);
  await store.query("UPDATE publisher_profiles SET status='inactive' WHERE user_id=$1",[f.ownerId]);
  await processPublicationCommit(config,{store});
  assert.equal((await store.getPublicationTask(f.ownerId,f.id)).errorCode,'skillhub.publication_task_publisher_changed');
  assert.equal((await store.getPublicationRequest(f.ownerId,f.id)).intent.receipt,null);
  await store.query("UPDATE publisher_profiles SET status='active' WHERE user_id=$1",[f.ownerId]);await enqueue(f);
  // Preserve storage consistency but corrupt the exact accepted request.
  await store.query("UPDATE publication_tasks SET candidate=candidate||decode('20','hex'),candidate_bytes=candidate_bytes+1 WHERE id=$1",[f.id]);
  await processPublicationCommit(config,{store});
  const result=await store.getPublicationTask(f.ownerId,f.id);
  assert.equal(result.state,'publish_failed');assert.equal(result.validation.status,409);
  assert.equal(JSON.stringify(result).includes('Private instructions'),false);
  assert.equal((await store.getPublicationRequest(f.ownerId,f.id)).intent.receipt,null);
  assert.equal((await countVersions(f)).rowCount,0);
});

test('PostgreSQL failed commit remains retryable after candidate TTL and cannot revive a yanked version',pg,async()=>{
  const f=await ready(await fixture());await enqueue(f);
  await processPublicationCommit(config,{store,beforeComplete:async()=>{
    await store.query("UPDATE publisher_profiles SET status='inactive' WHERE user_id=$1",[f.ownerId]);
  }});
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '1 day' WHERE id=$1",[f.id]);
  await store.query("UPDATE publisher_profiles SET status='active' WHERE user_id=$1",[f.ownerId]);
  assert.equal((await enqueue(f)).task.state,'publish_queued');
  await processPublicationCommit(config,{store});
  const version=(await countVersions(f)).rows[0];
  assert.ok(version);
  await store.query("UPDATE skill_versions SET status='yanked',yanked_at=now() WHERE id=$1",[version.id]);
  assert.equal((await enqueue(f)).task.state,'published');
  assert.equal(await processPublicationCommit(config,{store}),null);
  assert.equal((await countVersions(f)).rows[0].status,'yanked');
});
