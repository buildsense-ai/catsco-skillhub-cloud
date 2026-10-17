import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { before, after, afterEach, test } from 'node:test';
import { createDelegatedPublicationIntake } from '../../packages/publication-delegation/intake.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { loadConfig } from '../../packages/config/index.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import { createApiServer } from '../../apps/api/server.js';
import { hashSessionToken } from '../../packages/auth/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

const issuer='https://issuer.invalid', audience='https://cloud.invalid';
const hash=b=>createHash('sha256').update(b).digest('hex');
const id=()=>randomUUID().replaceAll('-','');
const databaseUrl=process.env.SKILLHUB_TEST_DATABASE_URL, pg={skip:!databaseUrl};
const config=loadConfig({databaseUrl,nodeEnv:'test',publicationTasksEnabled:true,publicationPublishingEnabled:true,
  publishValidationMaxConcurrent:8,sessionSecret:'delegated-intake-test'});
const settings=publicationTaskSettings(config);
function input(description='Fixture only') {
  const rawBody=Buffer.from(JSON.stringify({source:{type:'files',files:[{path:'SKILL.md',
    content:`---\nname: delegated-fixture\n${description ? `description: ${description}\n` : ''}---\nPrivate fixture`}]}}));
  const result=validatePublishRequest(rawBody.toString());
  const report=result.body.validation??result.body.error?.validation;
  return {rawBody,sourceSnapshotHash:report.candidateHash,entryRequestId:`pubentry_${id()}`,
    token:`pubupload_${id()+id()}`,idempotencyKey:`pubcandidate_${id()}`,authorityEpoch:1};
}
function observation(r,actor='85',overrides={}) {
  return {issuer,audience,action:'candidate.upload',actorCatsCoUid:actor,botUid:'999',
    entryRequestId:r.entryRequestId,candidateRevision:1,authorityEpoch:r.authorityEpoch,
    requestHash:hash(r.rawBody),requestBytes:r.rawBody.length,sourceSnapshotHash:r.sourceSnapshotHash,
    idempotencyKey:r.idempotencyKey,delegationId:`pubgrant_${id()}`,
    observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90000).toISOString(),...overrides};
}
const adapter=(store,peer,extra={})=>createDelegatedPublicationIntake({enabled:true,config,store,
  introspectionClient:{checkUploadGrant:peer},issuer,audience,...extra});

test('delegated intake defaults off; callers cannot supply authority or bypass byte/digest checks', async()=>{
  await assert.rejects(createDelegatedPublicationIntake()(input()),{code:'skillhub.publication_authority_disabled'});
  let calls=0;
  const accept=adapter({tx(){throw new Error('must not transact');},async maintainPublicationTasks(){}},async()=>{calls++;});
  await assert.rejects(accept({...input(),ownerId:'forged'}),{code:'skillhub.publication_authority_invalid'});
  await assert.rejects(accept({...input(),sourceSnapshotHash:'f'.repeat(64)}),{code:'skillhub.publication_task_candidate_changed'});
  await assert.rejects(accept({...input(),authorityEpoch:0}),{code:'skillhub.publication_authority_invalid'});
  const malformed=await accept({...input(),rawBody:Buffer.from('{')});
  assert.equal(malformed.accepted,false);
  assert.equal(calls,0);
});

test('delegated intake snapshots exact caller bytes and metadata before awaiting validation', async()=>{
  const original=input(), copy=Buffer.from(original.rawBody), entry=original.entryRequestId;
  const sentinel=new Error('transaction reached');
  const accept=adapter({async maintainPublicationTasks(){},tx(){throw sentinel;}},async r=>{
    assert.deepEqual(r.rawBody,copy); assert.equal(r.entryRequestId,entry);
    return observation(r);
  });
  const pending=accept(original);
  original.rawBody.fill(0); original.entryRequestId=`pubentry_${id()}`;
  await assert.rejects(pending,error=>error===sentinel);
});

test('delegated intake rejects wrong peer identity scope hashes and stale observations before SQL', async()=>{
  const store={async maintainPublicationTasks(){},tx(){throw new Error('must not transact');}};
  for (const override of [{issuer:'https://other.invalid'},{audience:'https://other.invalid'},
    {actorCatsCoUid:'0'},{actorCatsCoUid:'999'},{candidateRevision:2},{authorityEpoch:2},
    {action:'publish'},{requestHash:'0'.repeat(64)},{sourceSnapshotHash:'0'.repeat(64)},
    {requestBytes:1},{idempotencyKey:`pubcandidate_${id()}`},{expiresAt:new Date(0).toISOString()}]) {
    await assert.rejects(adapter(store,async r=>observation(r,'85',override))(input()),{code:'skillhub.publication_authority_inactive'});
  }
});

let store;
const owners=[];
before(()=>{if(databaseUrl) store=createStore(config);});
afterEach(async()=>{
  if (!store) return;
  for (const owner of owners.splice(0)) {
    await store.query('DELETE FROM publication_delegations WHERE task_id IN (SELECT id FROM publication_tasks WHERE owner_user_id=$1)',[owner]);
    await store.query('DELETE FROM users WHERE id=$1',[owner]);
  }
});
after(closePools);
async function fixture() {
  const actor=String(BigInt('0x'+id().slice(0,12))+1000n), suffix=id();
  const identity=await store.claimCatsCoPublisherIdentity({catsCoUid:actor,catsCoIssuer:issuer,namespace:`delegated-${suffix}`,
    displayName:'Delegated fixture',contact:'',internalEmail:`${suffix}@example.invalid`,passwordHash:'fixture'});
  owners.push(identity.user.id);
  const f={ownerId:identity.user.id,actor,profile:identity.developerProfile};
  f.accept=adapter(store,async r=>observation(r,actor));
  return f;
}
async function counts(owner) {
  return (await store.query(`SELECT count(*)::int AS tasks,
    (SELECT count(*)::int FROM publication_delegations d JOIN publication_tasks t ON t.id=d.task_id WHERE t.owner_user_id=$1) AS associations,
    (SELECT count(*)::int FROM publication_delegation_outbox o JOIN publication_tasks t ON t.id=o.task_id WHERE t.owner_user_id=$1) AS events
    FROM publication_tasks WHERE owner_user_id=$1`,[owner])).rows[0];
}

test('PostgreSQL delegated acceptance is atomic and concurrent/lost-response retries keep one association and outbox event',pg,async()=>{
  const f=await fixture(), r=input();
  const replies=await Promise.all(Array.from({length:5},()=>f.accept(r)));
  assert.equal(replies.filter(r=>r.created).length,1);
  assert.equal(new Set(replies.map(r=>r.association.taskId)).size,1);
  assert.equal(new Set(replies.map(r=>r.association.eventId)).size,1);
  assert.deepEqual(await counts(f.ownerId),{tasks:1,associations:1,events:1});
  const saved=(await store.query('SELECT * FROM publication_tasks WHERE id=$1',[replies[0].association.taskId])).rows[0];
  assert.deepEqual(saved.candidate,r.rawBody); assert.equal(saved.authority_kind,'catsco');
  const restarted=adapter(createStore(config),async req=>observation(req,f.actor));
  assert.deepEqual((await restarted(r)).association,replies[0].association);
  const publicText=JSON.stringify(replies);
  for (const secret of [r.token,r.idempotencyKey,'Private fixture',f.ownerId]) assert.ok(!publicText.includes(secret));
  // Renewing the short-lived grant does not allocate a new intent or event.
  assert.equal((await restarted({...r,token:`pubupload_${id()+id()}`})).created,false);
});

test('PostgreSQL delegated acceptance rejects changed exact bytes Bot epoch key or mapped owner',pg,async()=>{
  const f=await fixture(), other=await fixture(), r=input();
  await f.accept(r);
  for (const changed of [{...r,rawBody:Buffer.concat([r.rawBody,Buffer.from(' ')])},
    {...r,authorityEpoch:2},{...r,idempotencyKey:`pubcandidate_${id()}`}]) {
    await assert.rejects(f.accept(changed),{status:409});
  }
  await assert.rejects(adapter(store,async req=>observation(req,f.actor,{botUid:'998'}))(r),{status:409});
  await assert.rejects(other.accept(r),{status:409});
  assert.deepEqual(await counts(f.ownerId),{tasks:1,associations:1,events:1});
  assert.deepEqual(await counts(other.ownerId),{tasks:0,associations:0,events:0});
});

test('PostgreSQL delegated acceptance requires exact non-NULL issuer and active user/profile at commit',pg,async()=>{
  const f=await fixture();
  await assert.rejects(adapter(store,async r=>observation(r,'123'))(input()),{status:403});
  await assert.rejects(adapter(store,async r=>observation(r,f.actor,{issuer:'https://other.invalid'}),{issuer:'https://other.invalid'})(input()),{status:403});
  for (const table of ['users','publisher_profiles']) {
    const key=table==='users'?'id':'user_id';
    await store.query(`UPDATE ${table} SET status='disabled' WHERE ${key}=$1`,[f.ownerId]);
    await assert.rejects(f.accept(input()),{status:403});
    await store.query(`UPDATE ${table} SET status='active' WHERE ${key}=$1`,[f.ownerId]);
  }
  // A legacy UID created by generic profile provisioning is not issuer proof.
  const legacy=`legacy-${id()}`; owners.push(legacy);
  await store.query("INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'fixture','Legacy')",[legacy,`${legacy}@example.invalid`]);
  await store.ensureDeveloperProfile({userId:legacy,namespace:legacy,displayName:'Legacy',contact:'',catsCoUid:'124'});
  await assert.rejects(adapter(store,async r=>observation(r,'124'))(input()),{status:403});
  assert.deepEqual(await counts(f.ownerId),{tasks:0,associations:0,events:0});
});

test('PostgreSQL outbox write failure rolls back task and binding; retry is not a duplicate',pg,async()=>{
  const f=await fixture(), r=input(), failure=new Error('injected write fault');
  const failingStore={...store,tx:fn=>store.tx(client=>fn({query:(sql,args)=>{
    if(sql.startsWith('INSERT INTO publication_delegation_outbox')) throw failure;
    return client.query(sql,args);
  }}))};
  await assert.rejects(adapter(failingStore,async req=>observation(req,f.actor))(r),e=>e===failure);
  assert.deepEqual(await counts(f.ownerId),{tasks:0,associations:0,events:0});
  assert.equal((await f.accept(r)).created,true);
});

test('PostgreSQL account APIs and workers cannot read replay cancel or publish delegated tasks',pg,async()=>{
  const f=await fixture(), r=input(), {association:a}=await f.accept(r);
  assert.equal(await store.getPublicationTask(f.ownerId,a.taskId),null);
  assert.deepEqual(await store.listPublicationTasks(f.ownerId),[]);
  assert.equal(await store.findPublicationTaskForRequest(f.ownerId,r.idempotencyKey,hash(r.rawBody)),null);
  assert.equal(await store.cancelPublicationTask(f.ownerId,a.taskId),null);
  assert.equal(await store.getPublicationRequest(f.ownerId,a.taskId),null);
  await assert.rejects(store.enqueuePublicationCommit({ownerId:f.ownerId,id:a.taskId,profile:f.profile,candidateHash:r.sourceSnapshotHash}),{status:404});
  const account={ownerId:f.ownerId,requestKey:r.idempotencyKey,requestHash:hash(r.rawBody),candidateHash:r.sourceSnapshotHash,
    candidate:r.rawBody,result:validatePublishRequest(r.rawBody.toString()),settings};
  await assert.rejects(store.createPublicationTask(account),{status:409});
  assert.equal(await store.claimPublicationTask(settings),null);
  assert.equal(await store.claimPublicationCommit(settings),null);
  for (const sql of ["SET authority_kind='account',state='ready'", "SET state='queued'", "SET owner_user_id='changed'",
    "SET request_hash='changed'", "SET candidate=decode('ff','hex'),candidate_bytes=1"]) {
    await assert.rejects(store.query(`UPDATE publication_tasks ${sql} WHERE id=$1`,[a.taskId]),{code:'23514'});
  }
  const api=createApiServer(config,{store:{...store,getSessionByTokenHash:async h=>h===hashSessionToken('owner',config.session.secret)?{userId:f.ownerId}:null}});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  try {
    const root=`http://127.0.0.1:${api.address().port}/api/skills/publication-tasks`;
    const list=await fetch(root,{headers:{cookie:'catsco_session=owner'}});
    assert.equal(list.status,200); assert.deepEqual((await list.json()).tasks,[]);
    for (const suffix of ['', '/cancel','/publish']) {
      const response=await fetch(root+'/'+a.taskId+suffix,{method:suffix?'POST':'GET',headers:{cookie:'catsco_session=owner','content-type':'application/json'},
        ...(suffix?{body:JSON.stringify({candidateHash:r.sourceSnapshotHash,confirmVersionPublish:true})}:{})});
      assert.equal(response.status,404);
      assert.ok(!JSON.stringify(await response.json()).includes('Private fixture'));
    }
  } finally {api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
  // The normal account pipeline still works alongside a held delegation.
  const ordinary=await store.createPublicationTask({...account,requestKey:`account-${id()}`});
  assert.equal((await store.claimPublicationTask(settings)).id,ordinary.task.id);
});

test('PostgreSQL held candidate expiry clears bytes but preserves replay evidence and cannot resurrect source',pg,async()=>{
  const f=await fixture(), r=input(), {association:a}=await f.accept(r);
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '2 days',purge_after=now()-interval '1 day' WHERE id=$1",[a.taskId]);
  await store.maintainPublicationTasks();
  const row=(await store.query('SELECT candidate,candidate_bytes,state FROM publication_tasks WHERE id=$1',[a.taskId])).rows[0];
  assert.deepEqual(row,{candidate:null,candidate_bytes:'0',state:'delegated_pending'});
  const replay=await f.accept(r);
  assert.equal(replay.created,false); assert.equal(replay.association.candidateAvailable,false);
  assert.equal(replay.association.taskId,a.taskId);
  assert.deepEqual(await counts(f.ownerId),{tasks:1,associations:1,events:1});
  await assert.rejects(store.query('DELETE FROM publication_tasks WHERE id=$1',[a.taskId]),{code:'23503'});
  await assert.rejects(store.query('DELETE FROM users WHERE id=$1',[f.ownerId]),{code:'23503'});
});

test('PostgreSQL delegated and account tasks share storage/count budgets and conflicting request keys',pg,async()=>{
  const f=await fixture(), r=input();
  const limited={...config,publicationTasks:{...config.publicationTasks,maxTasksPerOwner:1}};
  const accept=adapter(store,async req=>observation(req,f.actor),{config:limited});
  await accept(r);
  await assert.rejects(accept(input()),{status:429});
  const account={ownerId:f.ownerId,requestKey:`account-${id()}`,requestHash:hash(r.rawBody),candidateHash:r.sourceSnapshotHash,
    candidate:r.rawBody,result:validatePublishRequest(r.rawBody.toString()),settings:publicationTaskSettings(limited)};
  await assert.rejects(store.createPublicationTask(account),{status:429});
  const other=await fixture(), blocked=input();
  await store.createPublicationTask({...account,ownerId:other.ownerId,requestKey:blocked.idempotencyKey});
  await assert.rejects(other.accept(blocked),{status:409});
  const tiny={...config,publicationTasks:{...config.publicationTasks,maxStoredBytesPerOwner:1}};
  await assert.rejects(adapter(store,async req=>observation(req,other.actor),{config:tiny})(input()),{status:429});
});

test('PostgreSQL readable format rejection is held with its bounded report, never published',pg,async()=>{
  const f=await fixture(), r=input('');
  const accepted=await f.accept(r);
  assert.equal(accepted.accepted,true);
  const row=(await store.query('SELECT state,intake_result FROM publication_tasks WHERE id=$1',[accepted.association.taskId])).rows[0];
  assert.equal(row.state,'delegated_pending'); assert.equal(row.intake_result.status,422);
  assert.equal(await store.claimPublicationCommit(settings),null);
});

test('PostgreSQL grant expiry or cancellation while entering SQL cannot commit an intake',pg,async()=>{
  const f=await fixture();
  const lateStore={...store,tx:async fn=>{await delay(1200);return store.tx(fn);}};
  await assert.rejects(adapter(lateStore,async r=>observation(r,f.actor,{expiresAt:new Date(Date.now()+700).toISOString()}))(input()),
    {code:'skillhub.publication_authority_inactive'});
  const controller=new AbortController();
  const abortedStore={...store,tx:fn=>store.tx(async client=>{
    controller.abort(); return fn(client);
  })};
  await assert.rejects(adapter(abortedStore,async r=>observation(r,f.actor))(input(),{signal:controller.signal}),
    {code:'skillhub.publication_authority_inactive'});
  assert.deepEqual(await counts(f.ownerId),{tasks:0,associations:0,events:0});
});

test('PostgreSQL migration 016 preserves existing ordinary tasks and rejects association to account tasks',pg,async()=>{
  const migrations=await Promise.all(['012_publication_tasks.sql','014_publication_commits.sql','016_delegated_publication_intake.sql']
    .map(name=>readFile(new URL(`../../infra/migrations/${name}`,import.meta.url),'utf8')));
  const schema=`delegated_migration_${id()}`;
  await store.tx(async client=>{
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query("CREATE TABLE users(id text PRIMARY KEY); INSERT INTO users VALUES('owner')");
    await client.query(migrations[0]); await client.query(migrations[1]);
    await client.query(`INSERT INTO publication_tasks(id,owner_user_id,request_key,request_hash,state,intake_result,expires_at,purge_after)
      VALUES('task','owner','key','hash','ready','{}',now()+interval '1 day',now()+interval '2 days')`);
    await client.query(migrations[2]);
    assert.deepEqual((await client.query('SELECT state,authority_kind FROM publication_tasks')).rows,[{state:'ready',authority_kind:'account'}]);
    await client.query("UPDATE publication_tasks SET state='cancelled' WHERE id='task'");
    await client.query('SAVEPOINT wrong_kind');
    await assert.rejects(client.query(`INSERT INTO publication_delegations
      (task_id,issuer,audience,entry_request_id,candidate_revision,actor_uid,bot_uid,profile_id,namespace,delegation_id,authority_epoch)
      VALUES('task','https://a.invalid','https://b.invalid','entry',1,'1','2','profile','namespace','grant',1)`),{code:'23503'});
    await client.query('ROLLBACK TO SAVEPOINT wrong_kind');
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  });
});
