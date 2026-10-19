import assert from 'node:assert/strict';
import {test,before,after,afterEach} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore,closePools} from '../../packages/database/store.js';
import {loadConfig} from '../../packages/config/index.js';
import {issueSigningKeyCertificate} from '../../packages/signing/index.js';
import {publicationTaskSettings} from '../../packages/publication-tasks/config.js';
import {createPublicationCommitStore} from '../../packages/publication-tasks/commit-store.js';
import {processPublicationCommit} from '../../packages/publication-tasks/commit-worker.js';
import {createDelegatedPublicationCommitCoordinator as createCoordinator,processDelegatedPublicationCommit as work} from '../../packages/publication-delegation/commit-coordinator.js';
import {createDelegatedPublicationControlStore} from '../../packages/publication-delegation/control-store.js';
import {createPublicationReceiptStore} from '../../packages/publication-delegation/receipt-store.js';
import {delegatedFixture,cleanupDelegatedFixture,id} from '../helpers/delegated-publication.js';

const databaseUrl=process.env.SKILLHUB_TEST_DATABASE_URL,pg={skip:!databaseUrl};
const issuer='https://commit.invalid',audience='https://cloud.invalid';
const code=k=>({code:'skillhub.delegated_commit_'+k});
let root,config,store,settings;const fixtures=[];
before(async()=>{
  if(!databaseUrl)return;
  root=await fs.mkdtemp(path.join(os.tmpdir(),'delegated-commits-'));
  config=loadConfig({root,databaseUrl,nodeEnv:'test',publicationTasksEnabled:true,publicationPublishingEnabled:true,allowAutoKeygen:true});
  store=createStore(config);settings=publicationTaskSettings(config);await issueSigningKeyCertificate(config);
});
afterEach(async()=>{if(store)for(const f of fixtures.splice(0))await cleanupDelegatedFixture(store,f);});
after(async()=>{await closePools();if(root)await fs.rm(root,{recursive:true,force:true});});
async function fixture(options){const f=await delegatedFixture(store,config,options);fixtures.push(f);return f;}
const task=async f=>(await store.query('SELECT * FROM publication_tasks WHERE id=$1',[f.receipt.taskId])).rows[0];
const count=async(f,table)=>(await store.query(`SELECT * FROM ${table} WHERE task_id=$1`,[f.receipt.taskId])).rows;
const control=()=>createDelegatedPublicationControlStore({enabled:true,store,issuer,audience});
const proof=({receipt,target})=>({schemaVersion:1,receipt,target,permitId:'pubpermit_'+id(),
  intentHash:'a'.repeat(64),authorityEpoch:1,authorizedAt:'2026-10-19T05:30:00.123456Z'});
const coordinator=(permitClient={authorize:async p=>proof(p)},extra={})=>createCoordinator({enabled:true,config,store,issuer,audience,permitClient,...extra});
const plan=(c,f)=>c.prepare(f.receipt,{confirmVersionPublish:false});
async function admitted(){const f=await fixture(),c=coordinator();const p=await plan(c,f);await c.authorize(f.receipt);return {f,c,p};}
const due=f=>store.query("UPDATE publication_tasks SET run_after=now()-interval '1 second' WHERE id=$1",[f.receipt.taskId]);

test('delegated coordinator and worker default off, strict configuration and references',async()=>{
  for(const enabled of [undefined,false,'true']){
    const c=createCoordinator({enabled});
    await assert.rejects(c.prepare({}),code('disabled'));await assert.rejects(c.authorize({}),code('disabled'));
    assert.equal(await work({}, {enabled,store:{}}),null);
  }
  const config=loadConfig({nodeEnv:'test',publicationTasksEnabled:true,publicationPublishingEnabled:true});
  const args={enabled:true,config,store:{query(){throw Error('private');},tx(){}},issuer,audience};
  for(const extra of [{issuer:'http://bad.invalid'},{audience:issuer},{store:{}},{config:loadConfig()}])
    assert.throws(()=>createCoordinator({...args,...extra}),code('configuration'));
  const c=createCoordinator(args);
  for(const r of [null,{},[],{token:'secret'}])await assert.rejects(c.authorize(r),code('invalid'));
});

test('PostgreSQL preflight rejects before any version or plan; one immutable plan under concurrent retry',pg,async()=>{
  const bad=await fixture({files:[{path:'scripts/skill.json',content:'{}'}]}),c=coordinator();
  await assert.rejects(plan(c,bad),code('rejected'));
  assert.equal((await count(bad,'publication_delegated_plans')).length,0);
  assert.equal((await store.query('SELECT 1 FROM publication_version_reservations WHERE owner_user_id=$1',[bad.owner])).rowCount,0);
  const f=await fixture();const plans=await Promise.all(Array.from({length:5},()=>plan(c,f)));
  for(const p of plans)assert.deepEqual(p,plans[0]);
  assert.equal(plans[0].target.version,'1.0.0');assert.equal('manifest' in plans[0],false);
  assert.equal((await count(f,'publication_delegated_plans')).length,1);
  await assert.rejects(c.prepare(f.receipt,{confirmVersionPublish:true}),code('conflict'));
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '1 second' WHERE id=$1",[f.receipt.taskId]);
  assert.deepEqual(await plan(coordinator(),f),plans[0]);
});

test('PostgreSQL cancellation before and during peer request wins without resurrecting bytes or retaining permit',pg,async()=>{
  const f=await fixture();let enter,release;
  const entered=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
  const c=coordinator({authorize:async p=>{enter();await barrier;return proof(p);}});
  await plan(c,f);
  const pending=assert.rejects(c.authorize(f.receipt),code('cancelled'));
  await entered;
  try {
    // This succeeds while the network request is blocked: no SQL locks held.
    assert.equal((await control().cancel(f.receipt)).executionState,'cancelled');
  }finally{release();}
  await pending;
  const row=await task(f);assert.equal(row.candidate,null);assert.equal(row.state,'cancelled');
  assert.ok(Number(row.commit_bytes)>0); // Retained plan remains quota-accounted.
  assert.equal((await count(f,'publication_delegated_permits')).length,0);
  assert.equal((await count(f,'publication_commits')).length,0);
  await assert.rejects(coordinator({authorize(){throw Error('must not call');}}).authorize(f.receipt),code('cancelled'));
  await assert.rejects(plan(c,f),code('cancelled'));
});

test('PostgreSQL permit and commit are atomic, exact replay never requeues, account paths remain isolated',pg,async()=>{
  const {f,c,p}=await admitted();
  assert.equal((await task(f)).state,'committing');
  assert.equal((await count(f,'publication_delegated_permits')).length,1);
  await assert.rejects(control().cancel(f.receipt),{code:'skillhub.publication_control_conflict'});
  const replay=await coordinator({authorize(){throw Error('must not request twice');}}).authorize(f.receipt);
  assert.equal(replay.replayed,true);assert.equal(replay.state,'committing');
  assert.equal(await store.getPublicationRequest(f.owner,f.receipt.taskId),null);
  await assert.rejects(store.enqueuePublicationCommit({ownerId:f.owner,id:f.receipt.taskId,
    candidateHash:f.receipt.sourceSnapshotHash,confirmVersionPublish:false}),{status:404});
  assert.equal(await processPublicationCommit(config,{store}),null);
  assert.equal(await work(config,{store}),null);
  await work(config,{enabled:true,store});
  const row=await task(f);assert.equal(row.state,'published',JSON.stringify(row));
  assert.equal(row.candidate,null);assert.equal(row.publication_result.skillId,p.target.skillId);
  assert.equal((await c.authorize(f.receipt)).state,'published');
  assert.equal(await work(config,{enabled:true,store}),null);
  const outbox=createPublicationReceiptStore(store,{issuer,audience});
  const lease=await outbox.claim();assert.deepEqual(lease.receipt,f.receipt);
  assert.equal(await outbox.finish(lease,{kind:'delivered',localIntentCancelled:false}),true);
  assert.equal((await store.query('SELECT 1 FROM skill_versions WHERE skill_id=$1',[p.target.skillId])).rowCount,1);
});

test('PostgreSQL lost peer reply retries frozen plan; lost Cloud ACK replays committed evidence without peer call',pg,async()=>{
  const f=await fixture();let retained,calls=0;
  const peer={authorize:async p=>{calls++;retained??=proof(p);assert.deepEqual(p.target,retained.target);
    if(calls===1)throw Error('private network failure');return retained;}};
  const c=coordinator(peer),p=await plan(c,f);
  await assert.rejects(c.authorize(f.receipt),code('unavailable'));
  assert.equal((await count(f,'publication_delegated_permits')).length,0);
  const lossy={...store,tx:async fn=>{const result=await store.tx(fn);
    if(result?.state==='committing')throw Error('lost SQL ACK');return result;}};
  await assert.rejects(coordinator(peer,{store:lossy}).authorize(f.receipt),code('unavailable'));
  assert.equal((await task(f)).state,'committing');
  const recovered=await coordinator({authorize(){throw Error('no fresh permit');}}).authorize(f.receipt);
  assert.equal(recovered.permitId,retained.permitId);assert.equal(calls,2);
  assert.deepEqual(await plan(c,f),p);
  assert.equal((await count(f,'publication_delegated_permits'))[0].proof.authorizedAt,retained.authorizedAt);
});

for(const stage of ['afterGit','afterArtifact','beforeComplete'])test(`PostgreSQL delegated ${stage} interruption recovers one immutable version`,pg,async()=>{
  const {f,p}=await admitted();let seen;
  await work(config,{enabled:true,store,[stage]:async(_task,value)=>{seen=value;throw Error('simulated interruption');}});
  assert.ok(seen);assert.equal((await task(f)).state,'publish_queued');
  const retained=(await count(f,'publication_commits'))[0];
  await due(f);await work(config,{enabled:true,store});
  assert.equal((await task(f)).state,'published');
  const final=(await count(f,'publication_commits'))[0];
  assert.deepEqual(final.identity,retained.identity);assert.deepEqual(final.receipt,retained.receipt);
  assert.equal(final.attempts,2);assert.equal(final.package_id,retained.package_id);
  assert.equal((await store.query('SELECT 1 FROM skill_versions WHERE skill_id=$1',[p.target.skillId])).rowCount,1);
});

test('PostgreSQL exhausted retries are not reset by permit replay and stale workers are fenced',pg,async()=>{
  const {f,c}=await admitted();
  const worker=createPublicationCommitStore({query:store.query,tx:store.tx,config,delegated:true});
  const first=await worker.claimPublicationCommit(settings);
  await store.query("UPDATE publication_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[f.receipt.taskId]);
  const second=await worker.claimPublicationCommit(settings);
  assert.notEqual(first.lease_token,second.lease_token);
  await assert.rejects(worker.beginPublicationCommit(first,first.intent.receipt),{code:'skillhub.publication_task_lease_lost'});
  assert.equal(await worker.failPublicationCommit(first,{retry:true}),false);
  await worker.failPublicationCommit(second,{retry:true});await due(f);
  await work(config,{enabled:true,store,afterGit(){throw Error('third failure');}});
  assert.equal((await task(f)).state,'publish_failed');
  assert.equal((await c.authorize(f.receipt)).state,'publish_failed');
  assert.equal((await count(f,'publication_commits'))[0].attempts,3);
  await due(f);assert.equal(await work(config,{enabled:true,store}),null);
});

test('PostgreSQL changed publisher is denied at prepare, commit and final package completion',pg,async()=>{
  const f=await fixture(),c=coordinator();
  await store.query("UPDATE users SET status='disabled' WHERE id=$1",[f.owner]);
  await assert.rejects(plan(c,f),code('publisher_changed'));
  await store.query("UPDATE users SET status='active' WHERE id=$1",[f.owner]);await plan(c,f);
  await store.query("UPDATE publisher_profiles SET status='disabled' WHERE user_id=$1",[f.owner]);
  await assert.rejects(c.authorize(f.receipt),code('publisher_changed'));
  await store.query("UPDATE publisher_profiles SET status='active' WHERE user_id=$1",[f.owner]);await c.authorize(f.receipt);
  await work(config,{enabled:true,store,beforeComplete:()=>store.query("UPDATE users SET status='disabled' WHERE id=$1",[f.owner])});
  assert.equal((await task(f)).state,'publish_failed');
  assert.equal((await store.query('SELECT 1 FROM skill_versions WHERE owner_user_id=$1',[f.owner])).rowCount,0);
});

test('PostgreSQL invalid permits and mismatched SQL evidence cannot enter execution or mutate retained target',pg,async()=>{
  const f=await fixture(),c=coordinator();await plan(c,f);
  for(const mutate of [p=>({...p,extra:'bad'}),p=>({...p,target:{...p.target,version:'9.0.0'}}),
    p=>({...p,receipt:{...p.receipt,eventId:'pubevent_'+randomUUID()}})]) {
    await assert.rejects(coordinator({authorize:async p=>mutate(proof(p))}).authorize(f.receipt),code('conflict'));
  }
  await assert.rejects(store.query("UPDATE publication_tasks SET state='committing' WHERE id=$1",[f.receipt.taskId]),{code:'23514'});
  await assert.rejects(store.query("UPDATE publication_delegated_plans SET target=target||'{\"version\":\"9.0.0\"}'::jsonb WHERE task_id=$1",[f.receipt.taskId]),{code:'23514'});
  const p=(await count(f,'publication_delegated_plans'))[0];
  await assert.rejects(store.query('INSERT INTO publication_commits(task_id,profile_id,namespace,confirm_version,manifest,identity,scan_id,package_id) VALUES($1,$2,$3,false,$4,$5,$6,$7)',
    [f.receipt.taskId,p.target.publisherProfileId,p.target.namespace,p.manifest,p.identity,'scan_'+id(),'pkg_'+id()]),{code:'23514'});
  await c.authorize(f.receipt);
  for(const sql of ["UPDATE publication_delegated_permits SET proof=proof WHERE task_id=$1",
    "UPDATE publication_commits SET delegated_permit_task=NULL WHERE task_id=$1",
    "UPDATE publication_commits SET manifest='{}'::jsonb WHERE task_id=$1",
    "UPDATE publication_commits SET receipt=NULL WHERE task_id=$1"])
    await assert.rejects(store.query(sql,[f.receipt.taskId]),{code:'23514'});
  await assert.rejects(store.query("UPDATE publication_tasks SET state='delegated_pending' WHERE id=$1",[f.receipt.taskId]),{code:'23514'});
});

test('PostgreSQL concurrent intake replay, planning, permit and cancellation never deadlock or overwrite outcome',pg,async()=>{
  for(let i=0;i<4;i++) {
    const f=await fixture(),c=coordinator();await plan(c,f);
    const settled=await Promise.allSettled([c.authorize(f.receipt),control().cancel(f.receipt),f.accept(f.input),plan(c,f)]);
    const row=await task(f);
    assert.ok(['committing','cancelled'].includes(row.state));
    for(const result of settled)if(result.status==='rejected')
      assert.ok(['skillhub.delegated_commit_cancelled','skillhub.publication_control_conflict'].includes(result.reason.code),String(result.reason));
    assert.equal((await count(f,'publication_commits')).length,row.state==='committing'?1:0);
    assert.equal((await count(f,'publication_delegated_permits')).length,row.state==='committing'?1:0);
  }
});

test('PostgreSQL quota failures roll back reservation and permit atomically, preserving exact retry facts',pg,async()=>{
  const f=await fixture();
  const limited=bytes=>({...config,publicationTasks:{...config.publicationTasks,maxStoredBytesPerOwner:bytes}});
  const initial=await task(f);
  await assert.rejects(plan(coordinator(undefined,{config:limited(Number(initial.candidate_bytes))}),f),code('storage_limit'));
  assert.deepEqual(await task(f),initial);
  assert.equal((await count(f,'publication_delegated_plans')).length,0);
  assert.equal((await store.query('SELECT 1 FROM publication_version_reservations WHERE owner_user_id=$1',[f.owner])).rowCount,0);
  const c=coordinator(),p=await plan(c,f),planned=await task(f);let retained;
  const peer={authorize:async input=>{retained??=proof(input);return retained;}};
  await assert.rejects(coordinator(peer,{config:limited(Number(planned.candidate_bytes)+Number(planned.commit_bytes))}).authorize(f.receipt),code('storage_limit'));
  assert.deepEqual(await task(f),planned);
  assert.equal((await count(f,'publication_delegated_permits')).length,0);
  assert.equal((await count(f,'publication_commits')).length,0);
  assert.equal((await coordinator(peer).authorize(f.receipt)).permitId,retained.permitId);
  assert.deepEqual(await plan(c,f),p);
});

test('PostgreSQL historical commit status is read-only, scoped, and projects no candidate or internal proof',pg,async()=>{
  const f=await fixture(),c=coordinator(),before=await task(f);
  const initial=await c.read(f.receipt);assert.equal(initial.state,'delegated_pending');assert.equal(initial.target,null);
  assert.deepEqual(await task(f),before);
  await assert.rejects(c.read({...f.receipt,eventId:'pubevent_'+randomUUID()}),code('not_found'));
  const p=await plan(c,f);assert.deepEqual((await c.read(f.receipt)).target,p.target);
  await c.authorize(f.receipt);assert.equal((await c.read(f.receipt)).state,'committing');
  await work(config,{enabled:true,store});const complete=await c.read(f.receipt);
  assert.equal(complete.state,'published');assert.equal(complete.result.skillId,p.target.skillId);
  assert.deepEqual(Object.keys(complete).sort(),['schemaVersion','receipt','state','target','permitId','result','errorCode'].sort());
  const json=JSON.stringify(complete);for(const secret of ['Private source','materialHash','authorizedAt','"manifest":','lease_token'])assert.ok(!json.includes(secret));
  await store.query("UPDATE users SET status='disabled' WHERE id=$1",[f.owner]);
  assert.deepEqual(await c.read(f.receipt),complete,'trusted peer can recover history; CatsCo must independently authorize original human');
  const stopped=await fixture();await control().cancel(stopped.receipt);assert.equal((await c.read(stopped.receipt)).state,'cancelled');
});

test('PostgreSQL migration019 preserves preexisting cancelled, held and ordinary evidence without backfill',pg,async()=>{
  const names=['012_publication_tasks.sql','014_publication_commits.sql','016_delegated_publication_intake.sql',
    '017_publication_receipt_delivery.sql','018_delegated_publication_cancellation.sql','019_delegated_publication_commit.sql'];
  const migrations=await Promise.all(names.map(n=>fs.readFile(new URL('../../infra/migrations/'+n,import.meta.url),'utf8')));
  const schema='commit_migration_'+id();
  await store.tx(async c=>{
    await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET LOCAL search_path TO ${schema}`);
    await c.query("CREATE TABLE users(id text PRIMARY KEY); INSERT INTO users VALUES('owner')");
    for(const migration of migrations.slice(0,-1))await c.query(migration);
    for(const [key,kind] of [['held','catsco'],['cancelled','catsco'],['ordinary','account']]) {
      await c.query(`INSERT INTO publication_tasks(id,owner_user_id,request_key,request_hash,candidate_hash,candidate,candidate_bytes,
        state,intake_result,expires_at,purge_after,authority_kind)
        VALUES($1,'owner',$1,$2,$2,$3,1,$4,'{}',now()+interval '1 day',now()+interval '2 days',$5)`,
        [key,'a'.repeat(64),Buffer.from('x'),kind==='catsco'?'delegated_pending':'queued',kind]);
      if(kind==='catsco') {
        await c.query(`INSERT INTO publication_delegations(task_id,issuer,audience,entry_request_id,candidate_revision,actor_uid,bot_uid,
          profile_id,namespace,delegation_id,authority_epoch,request_bytes) VALUES($1,$2,$3,$1,1,'1','2','profile','namespace',$1,1,1)`,[key,issuer,audience]);
        await c.query('INSERT INTO publication_delegation_outbox(task_id,event_id) VALUES($1,$1)',[key]);
      }
    }
    await c.query("UPDATE publication_tasks SET state='cancelled',candidate=NULL,candidate_bytes=0,delegated_cancelled_at=now() WHERE id='cancelled'");
    await c.query(`INSERT INTO publication_commits(task_id,profile_id,namespace,confirm_version,manifest,identity,scan_id,package_id)
      VALUES('ordinary','profile','namespace',false,'{}','{}','scan','package')`);
    const tables=['publication_tasks','publication_delegations','publication_delegation_outbox'];
    const before=await Promise.all(tables.map(t=>c.query(`SELECT * FROM ${t} ORDER BY 1`)));
    await c.query(migrations.at(-1));
    for(let i=0;i<tables.length;i++)assert.deepEqual((await c.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows,before[i].rows);
    assert.equal((await c.query('SELECT * FROM publication_delegated_plans')).rowCount,0);
    assert.equal((await c.query('SELECT * FROM publication_delegated_permits')).rowCount,0);
    assert.equal((await c.query('SELECT delegated_permit_task FROM publication_commits')).rows[0].delegated_permit_task,null);
    await c.query('SAVEPOINT invalid_insert');
    await assert.rejects(c.query(`INSERT INTO publication_tasks(id,owner_user_id,request_key,request_hash,state,intake_result,expires_at,purge_after,authority_kind)
      VALUES('bypass','owner','bypass','hash','committing','{}',now()+interval '1 day',now()+interval '2 days','catsco')`),{code:'23514'});
    await c.query('ROLLBACK TO SAVEPOINT invalid_insert');
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
  });
});
