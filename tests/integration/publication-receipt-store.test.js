import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { before, after, afterEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createDelegatedPublicationIntake } from '../../packages/publication-delegation/intake.js';
import { createPublicationReceiptStore } from '../../packages/publication-delegation/receipt-store.js';
import { createPublicationReceiptDispatcher } from '../../packages/publication-delegation/receipt-worker.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { loadConfig } from '../../packages/config/index.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';

const issuer='https://receipt.invalid',audience='https://cloud.invalid';
const databaseUrl=process.env.SKILLHUB_TEST_DATABASE_URL,pg={skip:!databaseUrl};
const config=loadConfig({databaseUrl,nodeEnv:'test',publicationTasksEnabled:true});
const id=()=>randomUUID().replaceAll('-','');
let store;const owners=[];
before(()=>{if(databaseUrl)store=createStore(config);});
afterEach(async()=>{
  if(!store)return;
  for(const owner of owners.splice(0)){
    await store.query('DELETE FROM publication_delegations WHERE task_id IN (SELECT id FROM publication_tasks WHERE owner_user_id=$1)',[owner]);
    await store.query('DELETE FROM users WHERE id=$1',[owner]);
  }
});
after(closePools);
const ledger=()=>createPublicationReceiptStore(store,{issuer,audience});
async function fixture(scope={issuer,audience}) {
  const suffix=id(),actor=String(BigInt('0x'+suffix.slice(0,12))+1000n);
  const identity=await store.claimCatsCoPublisherIdentity({catsCoUid:actor,catsCoIssuer:scope.issuer,namespace:`receipt-${suffix}`,
    displayName:'Receipt fixture',contact:'',internalEmail:`${suffix}@example.invalid`,passwordHash:'fixture'});
  owners.push(identity.user.id);
  const rawBody=Buffer.from(JSON.stringify({source:{type:'files',files:[{path:'SKILL.md',content:'---\nname: receipt-test\ndescription: Fixture only\n---\nPrivate source'}]}}));
  const input={rawBody,sourceSnapshotHash:validatePublishRequest(rawBody.toString()).body.validation.candidateHash,
    entryRequestId:`pubentry_${id()}`,token:`pubupload_${id()+id()}`,idempotencyKey:`pubcandidate_${id()}`,authorityEpoch:1};
  const accept=createDelegatedPublicationIntake({enabled:true,config,store,...scope,introspectionClient:{async checkUploadGrant(r){
    return {...scope,action:'candidate.upload',actorCatsCoUid:actor,botUid:'999',entryRequestId:r.entryRequestId,
      candidateRevision:1,authorityEpoch:r.authorityEpoch,requestHash:createHash('sha256').update(rawBody).digest('hex'),
      requestBytes:rawBody.length,sourceSnapshotHash:r.sourceSnapshotHash,idempotencyKey:r.idempotencyKey,
      delegationId:r.entryRequestId.replace('pubentry_','pubgrant_'),observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90000).toISOString()};
  }}});
  const {association}=await accept(input);
  return {owner:identity.user.id,input,association,accept};
}
const row=async f=>(await store.query('SELECT * FROM publication_delegation_outbox WHERE task_id=$1',[f.association.taskId])).rows[0];
const due=async f=>store.query("UPDATE publication_delegation_outbox SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1",[f.association.taskId]);
const expire=async f=>store.query("UPDATE publication_delegation_outbox SET lease_until=now()-interval '1 second' WHERE task_id=$1",[f.association.taskId]);
const ack=r=>({schemaVersion:1,recorded:true,entryRequestId:r.entryRequestId,eventId:r.eventId,taskId:r.taskId,localIntentCancelled:true,commitAllowed:false});

test('PostgreSQL receipt has one durable lease and same event after ACK loss and reconstruction',pg,async()=>{
  const f=await fixture(),l=ledger();
  const leases=(await Promise.all(Array.from({length:8},()=>l.claim()))).filter(Boolean);
  assert.equal(leases.length,1);const first=leases[0];
  assert.equal(first.receipt.requestBytes,f.input.rawBody.length);
  assert.equal(first.receipt.acceptanceEpoch,1);
  await f.accept({...f.input,authorityEpoch:2});
  await expire(f);
  const second=await ledger().claim();assert.deepEqual(second.receipt,first.receipt);assert.notEqual(second.token,first.token);
  assert.equal(await l.finish(first,{kind:'delivered',localIntentCancelled:false}),false);
  assert.equal(await ledger().finish(second,{kind:'delivered',localIntentCancelled:true}),true);
  assert.equal(await l.finish(second,{kind:'retry'}),false);
  const saved=await row(f);assert.equal(saved.delivery_state,'delivered');assert.equal(saved.delivery_attempts,2);
  assert.equal(saved.local_intent_cancelled,true);assert.ok(saved.delivered_at);assert.equal(await l.claim(),null);
  const task=(await store.query('SELECT state,authority_kind,candidate FROM publication_tasks WHERE id=$1',[f.association.taskId])).rows[0];
  assert.equal(task.state,'delegated_pending');assert.equal(task.authority_kind,'catsco');assert.deepEqual(task.candidate,f.input.rawBody);
  assert.equal(await store.getPublicationTask(f.owner,f.association.taskId),null);
  assert.equal(await store.cancelPublicationTask(f.owner,f.association.taskId),null);
});
test('PostgreSQL retry backoff and eight-attempt budget survive worker reconstruction',pg,async()=>{
  const f=await fixture();
  for(let attempt=1;attempt<=8;attempt++){
    const l=ledger(),lease=await l.claim();assert.ok(lease);assert.equal((await row(f)).delivery_attempts,attempt);
    await l.finish(lease,{kind:'retry'});
    const saved=await row(f);assert.equal(saved.delivery_state,attempt===8?'exhausted':'pending');
    const seconds=(saved.next_attempt_at-Date.now())/1000,expected=Math.min(300,5*2**(attempt-1));
    assert.ok(seconds>expected-3&&seconds<=expected+1,`${seconds} ~= ${expected}`);
    assert.equal(await ledger().claim(),null);await due(f);
  }
  assert.equal((await row(f)).last_code,'exhausted');assert.equal(await ledger().claim(),null);
});
test('PostgreSQL crash on attempt eight exhausts without starving another event',pg,async()=>{
  const f=await fixture();await store.query('UPDATE publication_delegation_outbox SET delivery_attempts=7 WHERE task_id=$1',[f.association.taskId]);
  const old=await ledger().claim();await expire(f);const next=await fixture();
  const claimed=await ledger().claim();assert.equal(claimed.receipt.taskId,next.association.taskId);
  assert.equal((await row(f)).delivery_state,'exhausted');
  assert.equal(await ledger().finish(old,{kind:'delivered',localIntentCancelled:false}),false);
});
test('PostgreSQL exact conflict blocks one receipt without consuming unrelated tasks',pg,async()=>{
  const f=await fixture(),first=await ledger().claim();await ledger().finish(first,{kind:'conflict'});
  const next=await fixture(),second=await ledger().claim();assert.equal(second.receipt.taskId,next.association.taskId);
  assert.equal((await row(f)).delivery_state,'blocked');assert.equal((await row(f)).last_code,'conflict');
  for(const sql of ["event_id='changed'","created_at=now()-interval '1 day'","task_id='changed'"])
    await assert.rejects(store.query(`UPDATE publication_delegation_outbox SET ${sql} WHERE task_id=$1`,[f.association.taskId]),{code:'23514'});
  await assert.rejects(store.query('UPDATE publication_delegations SET request_bytes=1 WHERE task_id=$1',[f.association.taskId]),{code:'23514'});
});
test('PostgreSQL scope is applied before limit and wrong scope cannot finish',pg,async()=>{
  const other=await fixture({issuer:'https://other.invalid',audience}),f=await fixture();
  const claimed=await ledger().claim();assert.equal(claimed.receipt.taskId,f.association.taskId);
  const wrong=createPublicationReceiptStore(store,{issuer:'https://other.invalid',audience});
  assert.equal(await wrong.finish(claimed,{kind:'delivered',localIntentCancelled:false}),false);
  assert.equal((await wrong.claim()).receipt.taskId,other.association.taskId);
});
test('PostgreSQL historical evidence survives candidate expiry disabled owner and changed profile identity',pg,async()=>{
  const f=await fixture();
  const before=(await store.query('SELECT * FROM publication_delegations WHERE task_id=$1',[f.association.taskId])).rows[0];
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '2 days',purge_after=now()-interval '1 day' WHERE id=$1",[f.association.taskId]);
  await store.maintainPublicationTasks();
  await store.query("UPDATE users SET status='disabled' WHERE id=$1",[f.owner]);
  await store.query("UPDATE publisher_profiles SET status='disabled',namespace=namespace||'-changed' WHERE user_id=$1",[f.owner]);
  const lease=await ledger().claim();assert.equal(lease.receipt.requestBytes,f.input.rawBody.length);
  await ledger().finish(lease,{kind:'delivered',localIntentCancelled:true});
  assert.deepEqual((await store.query('SELECT * FROM publication_delegations WHERE task_id=$1',[f.association.taskId])).rows[0],before);
  assert.deepEqual((await store.query('SELECT candidate,candidate_bytes,state FROM publication_tasks WHERE id=$1',[f.association.taskId])).rows[0],
    {candidate:null,candidate_bytes:'0',state:'delegated_pending'});
});
test('PostgreSQL successful network plus failed local completion remains recoverable',pg,async()=>{
  const f=await fixture(),real=ledger();let delivered;
  const failing={claim:()=>real.claim(),finish:async()=>{throw new Error('private database detail');}};
  const dispatcher=createPublicationReceiptDispatcher({enabled:true,issuer,audience,peerSecret:'1'.repeat(64),store},
    {ledger:failing,client:{async deliver(r){delivered=r;return ack(r);}}});
  await assert.rejects(dispatcher.runOnce(),{code:'skillhub.publication_receipt_storage'});await dispatcher.stop();
  assert.equal((await row(f)).delivery_state,'leased');await expire(f);
  const replay=await ledger().claim();assert.deepEqual(replay.receipt,delivered);
  await ledger().finish(replay,{kind:'delivered',localIntentCancelled:true});assert.equal((await row(f)).delivery_state,'delivered');
});
test('PostgreSQL migration017 recovers only intact evidence and preserves immutable legacy associations',pg,async()=>{
  const files=['012_publication_tasks.sql','014_publication_commits.sql','016_delegated_publication_intake.sql','017_publication_receipt_delivery.sql'];
  const migrations=await Promise.all(files.map(name=>readFile(new URL(`../../infra/migrations/${name}`,import.meta.url),'utf8')));
  const schema=`receipt_migration_${id()}`;
  await store.tx(async c=>{
    await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET LOCAL search_path TO ${schema}`);
    await c.query("CREATE TABLE users(id text PRIMARY KEY); INSERT INTO users VALUES('owner')");
    for(const migration of migrations.slice(0,3))await c.query(migration);
    for(const intact of [true,false]){
      const task=`pubtask_${randomUUID()}`,event=`pubevent_${randomUUID()}`;
      await c.query(`INSERT INTO publication_tasks(id,owner_user_id,request_key,request_hash,candidate_hash,candidate,candidate_bytes,state,intake_result,expires_at,purge_after,authority_kind)
        VALUES($1,'owner',$2,$3,$3,$4,$5,'delegated_pending','{}',now()+interval '1 day',now()+interval '2 days','catsco')`,
      [task,`pubcandidate_${id()}`,'a'.repeat(64),intact?Buffer.from('abc'):null,intact?3:0]);
      await c.query(`INSERT INTO publication_delegations(task_id,issuer,audience,entry_request_id,candidate_revision,actor_uid,bot_uid,profile_id,namespace,delegation_id,authority_epoch)
        VALUES($1,$2,$3,$4,1,'1','2','profile','namespace',$5,1)`,[task,issuer,audience,`pubentry_${id()}`,`pubgrant_${id()}`]);
      await c.query('INSERT INTO publication_delegation_outbox(task_id,event_id) VALUES($1,$2)',[task,event]);
    }
    const before=(await c.query('SELECT * FROM publication_delegations ORDER BY task_id')).rows;
    await c.query(migrations[3]);
    const after=(await c.query('SELECT * FROM publication_delegations ORDER BY task_id')).rows;
    for(let i=0;i<after.length;i++){const {request_bytes,...rest}=after[i];assert.deepEqual(rest,before[i]);}
    assert.deepEqual(after.map(r=>r.request_bytes).sort(),['3',null].sort());
    const scoped=createPublicationReceiptStore({tx:fn=>fn(c)},{issuer,audience});
    let valid;
    for(let i=0;i<3;i++){const lease=await scoped.claim();if(lease)valid=lease;}
    assert.equal(valid.receipt.requestBytes,3);
    const states=(await c.query('SELECT delivery_state,last_code FROM publication_delegation_outbox')).rows;
    assert.ok(states.some(r=>r.delivery_state==='blocked'&&r.last_code==='evidence_missing'));
    await c.query('SAVEPOINT immutable');
    await assert.rejects(c.query('UPDATE publication_delegations SET request_bytes=4'),{code:'23514'});
    await c.query('ROLLBACK TO SAVEPOINT immutable');
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
  });
});
