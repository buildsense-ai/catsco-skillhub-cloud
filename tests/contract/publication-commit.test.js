import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../../packages/config/index.js';
import {createStore,closePools} from '../../packages/database/store.js';
import {issueSigningKeyCertificate} from '../../packages/signing/index.js';
import {validatePublishRequest} from '../../packages/publish-validation/index.js';
import {createPublicationIntrospectionClient} from '../../packages/publication-delegation/introspection.js';
import {createPublicationReceiptClient} from '../../packages/publication-delegation/receipt-client.js';
import {createPublicationCommitPermitClient} from '../../packages/publication-delegation/commit-permit-client.js';
import {createDelegatedPublicationControlStore} from '../../packages/publication-delegation/control-store.js';
import {createDelegatedPublicationCommitCoordinator,processDelegatedPublicationCommit} from '../../packages/publication-delegation/commit-coordinator.js';
import {delegatedFixture,cleanupDelegatedFixture,delegatedSource,hash} from '../helpers/delegated-publication.js';

test('real CatsCo + Cloud PostgreSQL: frozen plan, human intent, HTTPS permit, cancel ordering and recoverable Git/package publication',
  {timeout:240000},async t=>{
  assert.ok(process.env.CATSCO_CONTRACT_ROOT && process.env.CATS_PG_TEST_DSN && process.env.SKILLHUB_TEST_DATABASE_URL,
    'both repositories and real databases are REQUIRED, not skipped');
  const catsRoot=path.resolve(process.env.CATSCO_CONTRACT_ROOT);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:catsRoot,encoding:'utf8'}).trim(),process.env.CATSCO_CONTRACT_REVISION);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'skillhub-dual-commit-'));
  let child,closed,lines,store;const fixtures=[];
  t.after(async()=>{
    try{if(store)for(const f of fixtures)await cleanupDelegatedFixture(store,f);}finally{
      await closePools();lines?.close();
      if(child){child.stdin.end();const timer=setTimeout(()=>child.kill(),5000);await closed;clearTimeout(timer);}
      await fs.rm(root,{recursive:true,force:true});
    }
  });
  const binary=path.join(root,process.platform==='win32'?'peer.exe':'peer');
  execFileSync('go',['build','-mod=readonly','-o',binary,fileURLToPath(new URL('./commit-peer/main.go',import.meta.url))],
    {cwd:catsRoot,env:{...process.env,GOWORK:'off'},stdio:'pipe',timeout:150000});
  child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-4096));
  closed=new Promise(r=>child.once('close',r));lines=createInterface({input:child.stdout});
  const response=()=>new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);lines.off('line',line);child.off('exit',exit);};
    const line=s=>{cleanup();try{resolve(JSON.parse(s));}catch(e){reject(e);}};
    const exit=code=>{cleanup();reject(Error(`test peer exited ${code}: ${stderr}`));};
    const timer=setTimeout(()=>{cleanup();reject(Error('test peer command timeout'));},20000);
    lines.once('line',line);child.once('exit',exit);
  });
  const startup=await response();
  const command=async input=>{const pending=response();child.stdin.write(JSON.stringify(input)+'\n');return pending;};
  const peer={enabled:true,issuer:startup.origin,audience:'https://hub.example',peerSecret:'1'.repeat(64)};
  const transport={requestImpl:(url,options,callback)=>https.request(url,{...options,ca:startup.ca},callback)};
  const introspectionClient=createPublicationIntrospectionClient(peer,transport);
  const receiptClient=createPublicationReceiptClient(peer,transport);
  const permitClient=createPublicationCommitPermitClient(peer,transport);
  const config=loadConfig({root:path.join(root,'cloud'),databaseUrl:process.env.SKILLHUB_TEST_DATABASE_URL,nodeEnv:'test',
    publicationTasksEnabled:true,publicationPublishingEnabled:true,allowAutoKeygen:true});
  store=createStore(config);await issueSigningKeyCertificate(config);
  const coordinator=()=>createDelegatedPublicationCommitCoordinator({...peer,store,config,permitClient});
  const control=createDelegatedPublicationControlStore({...peer,store});
  const state=async f=>(await store.query('SELECT state FROM publication_tasks WHERE id=$1',[f.receipt.taskId])).rows[0].state;
  async function prepare(){
    const raw=delegatedSource(),sourceHash=validatePublishRequest(raw.toString()).body.validation.candidateHash;
    const {actor,...grant}=await command({action:'seed',requestHash:hash(raw),sourceHash,bytes:raw.length});
    const f=await delegatedFixture(store,config,{issuer:peer.issuer,audience:peer.audience,actor,grant,introspectionClient});
    fixtures.push(f);f.actor=actor;
    assert.equal((await receiptClient.deliver(f.receipt)).commitAllowed,false);
    const plan=await coordinator().prepare(f.receipt,{confirmVersionPublish:false});
    return {f,plan};
  }
  const {f,plan}=await prepare();
  await assert.rejects(coordinator().authorize(f.receipt),{code:'skillhub.publication_commit_permit_conflict'});
  assert.equal((await command({action:'count'})).count,0,'service cannot invent trusted human intent');
  // This is explicit test-only human admission, not a live UI/runtime E2E.
  await command({action:'admit',actor:f.actor,...plan});
  await command({action:'lose'});
  await assert.rejects(coordinator().authorize(f.receipt),{code:'skillhub.publication_commit_permit_unavailable'});
  assert.equal((await command({action:'count'})).count,1,'permit committed in CatsCo before dropped reply');
  assert.equal(await state(f),'delegated_pending');
  assert.equal((await store.query('SELECT 1 FROM publication_commits WHERE task_id=$1',[f.receipt.taskId])).rowCount,0);
  await command({action:'reopen'});
  assert.deepEqual(await coordinator().prepare(f.receipt,{confirmVersionPublish:false}),plan);
  assert.equal((await coordinator().authorize(f.receipt)).state,'committing');
  await command({action:'cancel',actor:f.actor,receipt:f.receipt});
  await assert.rejects(control.cancel(f.receipt),{code:'skillhub.publication_control_conflict'});
  await processDelegatedPublicationCommit(config,{enabled:true,store,afterArtifact(){throw Error('test interruption');}});
  assert.equal(await state(f),'publish_queued');
  const retained=(await store.query('SELECT * FROM publication_commits WHERE task_id=$1',[f.receipt.taskId])).rows[0];
  await store.query("UPDATE publication_tasks SET run_after=now()-interval '1 second' WHERE id=$1",[f.receipt.taskId]);
  await processDelegatedPublicationCommit(config,{enabled:true,store});
  assert.equal(await state(f),'published');
  const replay=await coordinator().authorize(f.receipt);assert.equal(replay.replayed,true);
  const final=(await store.query('SELECT * FROM publication_commits WHERE task_id=$1',[f.receipt.taskId])).rows[0];
  assert.deepEqual(final.identity,retained.identity);assert.deepEqual(final.receipt,retained.receipt);
  assert.equal((await store.query('SELECT 1 FROM skill_versions WHERE skill_id=$1',[plan.target.skillId])).rowCount,1);
  const stopped=await prepare();await command({action:'admit',actor:stopped.f.actor,...stopped.plan});
  await command({action:'cancel',actor:stopped.f.actor,receipt:stopped.f.receipt});
  await assert.rejects(coordinator().authorize(stopped.f.receipt),{code:'skillhub.publication_commit_permit_cancelled'});
  assert.equal((await control.cancel(stopped.f.receipt)).executionState,'cancelled');
  // A historical CatsCo permit is not allowed to resurrect a Cloud cancellation.
  const late=await prepare();await command({action:'admit',actor:late.f.actor,...late.plan});
  await command({action:'lose'});
  await assert.rejects(coordinator().authorize(late.f.receipt),{code:'skillhub.publication_commit_permit_unavailable'});
  await control.cancel(late.f.receipt);
  await assert.rejects(coordinator().authorize(late.f.receipt),{code:'skillhub.delegated_commit_cancelled'});
  assert.equal((await command({action:'count'})).count,2);
  assert.equal((await store.query('SELECT 1 FROM publication_delegated_permits')).rowCount,1);
  t.diagnostic('Real dual PostgreSQL + HTTPS + Git + signed package; source probe and human intent are test-seeded. No live UI, paid model, or production switches.');
});
