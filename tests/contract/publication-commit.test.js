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
import {createDelegatedPublicationScheduler} from '../../packages/publication-delegation/commit-scheduler.js';
import {delegatedFixture,cleanupDelegatedFixture,delegatedSource,hash} from '../helpers/delegated-publication.js';
import {createPublicationCommitHandler} from '../../apps/api/publication-commit.js';
import {publicationPeerTLS} from '../helpers/publication-peer-tls.js';

test('real CatsCo + Cloud PostgreSQL: frozen plan, human intent, HTTPS permit, cancel ordering and recoverable Git/package publication',
  {timeout:240000},async t=>{
  assert.ok(process.env.CATSCO_CONTRACT_ROOT && process.env.CATS_PG_TEST_DSN && process.env.SKILLHUB_TEST_DATABASE_URL,
    'both repositories and real databases are REQUIRED, not skipped');
  const catsRoot=path.resolve(process.env.CATSCO_CONTRACT_ROOT);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:catsRoot,encoding:'utf8'}).trim(),process.env.CATSCO_CONTRACT_REVISION);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'skillhub-dual-commit-'));
  let child,closed,lines,store,cloudServer,tls,handler;const fixtures=[];
  t.after(async()=>{
    try{if(store)for(const f of fixtures)await cleanupDelegatedFixture(store,f);}finally{
      if(cloudServer){cloudServer.closeAllConnections();await new Promise(r=>cloudServer.close(r));}
      await tls?.close();await closePools();lines?.close();
      if(child){child.stdin.end();const timer=setTimeout(()=>child.kill(),5000);await closed;clearTimeout(timer);}
      await fs.rm(root,{recursive:true,force:true});
    }
  });
  const binary=path.join(root,process.platform==='win32'?'peer.exe':'peer');
  execFileSync('go',['build','-mod=readonly','-o',binary,fileURLToPath(new URL('./commit-peer/main.go',import.meta.url))],
    {cwd:catsRoot,env:{...process.env,GOWORK:'off'},stdio:'pipe',timeout:150000});
  tls=await publicationPeerTLS();
  cloudServer=https.createServer(tls,(req,res)=>void handler(req,res));
  await new Promise(r=>cloudServer.listen(0,'127.0.0.1',r));
  const audience=`https://127.0.0.1:${cloudServer.address().port}`;
  const caPath=path.join(root,'cloud-ca.pem');await fs.writeFile(caPath,tls.cert);
  child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,PEER_TEST_AUDIENCE:audience,SSL_CERT_FILE:caPath}});
  let stderr='';child.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-4096));
  closed=new Promise(r=>child.once('close',r));lines=createInterface({input:child.stdout});
  const response=()=>new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);lines.off('line',line);child.off('exit',exit);};
    const line=s=>{cleanup();try{resolve(JSON.parse(s));}catch(e){reject(e);}};
    const exit=code=>{cleanup();reject(Error(`test peer exited ${code}: ${stderr}`));};
    const timer=setTimeout(()=>{cleanup();reject(Error('test peer command timeout'));},30000);
    lines.once('line',line);child.once('exit',exit);
  });
  const startup=await response();
  const command=async input=>{const pending=response();child.stdin.write(JSON.stringify(input)+'\n');return pending;};
  const peer={enabled:true,issuer:startup.origin,audience,peerSecret:'1'.repeat(64)};
  const transport={requestImpl:(url,options,callback)=>https.request(url,{...options,ca:startup.ca},callback)};
  const introspectionClient=createPublicationIntrospectionClient(peer,transport);
  const receiptClient=createPublicationReceiptClient(peer,transport);
  const permitClient=createPublicationCommitPermitClient(peer,transport);
  const config=loadConfig({root:path.join(root,'cloud'),databaseUrl:process.env.SKILLHUB_TEST_DATABASE_URL,nodeEnv:'test',
    publicationTasksEnabled:true,publicationPublishingEnabled:true,publicationDelegatedWorkerEnabled:true,allowAutoKeygen:true});
  store=createStore(config);await issueSigningKeyCertificate(config);
  handler=createPublicationCommitHandler({...config,publicationCommitService:{...peer,trustedProxyAddresses:[]}},store,
    {coordinator:createDelegatedPublicationCommitCoordinator({...peer,store,config,permitClient})});
  const cloudCall=async(action,receipt,extra={})=>{
    const body=await command({action:'cloud-'+action,receipt,...extra});
    if(body.error)throw Object.assign(Error('Cloud service rejected'),body.error);
    return body;
  };
  const coordinator=()=>({prepare:(r,o)=>cloudCall('plan',r,o),authorize:r=>cloudCall('authorize',r),read:r=>cloudCall('read',r)});
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
  await assert.rejects(coordinator().authorize(f.receipt),{code:'skillhub.delegated_commit_conflict'});
  assert.equal((await command({action:'count'})).count,0,'service cannot invent trusted human intent');
  // This is explicit test-only human admission, not a live UI/runtime E2E.
  await command({action:'admit',actor:f.actor,...plan});
  await command({action:'lose'});
  await assert.rejects(coordinator().authorize(f.receipt),{code:'skillhub.delegated_commit_unavailable'});
  assert.equal((await command({action:'count'})).count,1,'permit committed in CatsCo before dropped reply');
  assert.equal(await state(f),'delegated_pending');
  assert.equal((await store.query('SELECT 1 FROM publication_commits WHERE task_id=$1',[f.receipt.taskId])).rowCount,0);
  await command({action:'reopen'});
  assert.deepEqual(await coordinator().prepare(f.receipt,{confirmVersionPublish:false}),plan);
  assert.equal((await coordinator().authorize(f.receipt)).state,'committing');
  await command({action:'cancel',actor:f.actor,receipt:f.receipt});
  await assert.rejects(control.cancel(f.receipt),{code:'skillhub.publication_control_conflict'});
  const interrupted=createDelegatedPublicationScheduler(config,{store,
    processCommit:(c,o)=>processDelegatedPublicationCommit(c,{...o,afterArtifact(){throw Error('test interruption');}})});
  await interrupted.run({once:true});await interrupted.stop();
  assert.equal(await state(f),'publish_queued');
  const retained=(await store.query('SELECT * FROM publication_commits WHERE task_id=$1',[f.receipt.taskId])).rows[0];
  await store.query("UPDATE publication_tasks SET run_after=now()-interval '1 second' WHERE id=$1",[f.receipt.taskId]);
  // New scheduler, same durable identity/attempt budget. No direct worker call.
  const resumed=createDelegatedPublicationScheduler(config,{store});
  await resumed.run({once:true});await resumed.stop();
  assert.equal(await state(f),'published');
  const replay=await coordinator().authorize(f.receipt);assert.equal(replay.state,'published');
  const observed=await coordinator().read(f.receipt);assert.equal(observed.result.skillId,plan.target.skillId);
  const final=(await store.query('SELECT * FROM publication_commits WHERE task_id=$1',[f.receipt.taskId])).rows[0];
  assert.deepEqual(final.identity,retained.identity);assert.deepEqual(final.receipt,retained.receipt);
  assert.equal((await store.query('SELECT 1 FROM skill_versions WHERE skill_id=$1',[plan.target.skillId])).rowCount,1);
  const stopped=await prepare();await command({action:'admit',actor:stopped.f.actor,...stopped.plan});
  await command({action:'cancel',actor:stopped.f.actor,receipt:stopped.f.receipt});
  await assert.rejects(coordinator().authorize(stopped.f.receipt),{code:'skillhub.delegated_commit_cancelled'});
  assert.equal((await control.cancel(stopped.f.receipt)).executionState,'cancelled');
  // A historical CatsCo permit is not allowed to resurrect a Cloud cancellation.
  const late=await prepare();await command({action:'admit',actor:late.f.actor,...late.plan});
  await command({action:'lose'});
  await assert.rejects(coordinator().authorize(late.f.receipt),{code:'skillhub.delegated_commit_unavailable'});
  await control.cancel(late.f.receipt);
  await assert.rejects(coordinator().authorize(late.f.receipt),{code:'skillhub.delegated_commit_cancelled'});
  assert.equal((await command({action:'count'})).count,2);
  assert.equal((await store.query('SELECT 1 FROM publication_delegated_permits')).rowCount,1);
  const idle=createDelegatedPublicationScheduler(config,{store});
  assert.equal(await idle.tick(),null,'cancelled/unpermitted/published tasks are never claimed');
  await idle.stop();
  t.diagnostic('Real dual PostgreSQL + HTTPS + Git + signed package; source probe and human intent are test-seeded. No live UI, paid model, or production switches.');
});
