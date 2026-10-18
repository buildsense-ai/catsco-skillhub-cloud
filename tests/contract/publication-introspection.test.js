import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPublicationIntrospectionClient } from '../../packages/publication-delegation/introspection.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { createDelegatedPublicationIntake } from '../../packages/publication-delegation/intake.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { loadConfig } from '../../packages/config/index.js';
import { createPublicationReceiptClient } from '../../packages/publication-delegation/receipt-client.js';
import { createPublicationReceiptDispatcher } from '../../packages/publication-delegation/receipt-worker.js';

async function fixture(t) {
  assert.ok(process.env.CATSCO_CONTRACT_ROOT, 'CATSCO_CONTRACT_ROOT is required; missing counterpart is not a skip');
  const root = path.resolve(process.env.CATSCO_CONTRACT_ROOT);
  assert.ok((await stat(path.join(root, 'go.mod'))).isFile());
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.env.CATSCO_CONTRACT_REVISION) assert.equal(revision, process.env.CATSCO_CONTRACT_REVISION);
  t.diagnostic(`CatsCo counterpart ${revision}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'skillhub-peer-contract-'));
  let child, closed, lines;
  t.after(async () => {
    lines?.close();
    if (child) {
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 5000);
      await closed; clearTimeout(killer);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const binary = path.join(dir, process.platform === 'win32' ? 'peer.exe' : 'peer');
  execFileSync('go', ['build', '-mod=readonly', '-o', binary, fileURLToPath(new URL('./catsco-peer/main.go', import.meta.url))],
    { cwd: root, env: { ...process.env, GOWORK: 'off' }, stdio: 'pipe', timeout: 150000 });
  const raw = Buffer.from(JSON.stringify({ source: { type: 'files', files: [{ path: 'SKILL.md',
    content: '---\nname: contract\ndescription: Synthetic test\n---\n# Private test content' }] } }));
  const validation = validatePublishRequest(raw.toString());
  assert.equal(validation.status, 200);
  const sourceHash = validation.body.validation.candidateHash;
  child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env,
    PEER_TEST_BYTES: String(raw.length), PEER_TEST_HASH: createHash('sha256').update(raw).digest('hex'), PEER_TEST_SOURCE_HASH: sourceHash } });
  let stderr = '';
  child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4096); });
  closed = new Promise(resolve => { child.once('close', resolve); });
  lines = createInterface({ input: child.stdout });
  const startup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Peer fixture startup timeout')), 10000);
    lines.once('line', line => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch { reject(new Error('Peer fixture invalid startup')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Peer fixture exited ${code}: ${stderr}`)); });
  });
  const config = { enabled: true, issuer: startup.origin, audience: 'https://hub.example', peerSecret: '1'.repeat(64) };
  const transport = { requestImpl: (url, options, callback) => https.request(url, { ...options, ca: startup.ca }, callback) };
  const client = createPublicationIntrospectionClient(config, transport);
  const input = { token: 'pubupload_' + '2'.repeat(64), entryRequestId: 'pubentry_' + '3'.repeat(32), authorityEpoch: 1,
    rawBody: raw, sourceSnapshotHash: sourceHash, idempotencyKey: 'pubcandidate_' + '5'.repeat(32) };
  const command = text => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { lines.off('line', onLine); reject(new Error('Peer rotation timeout')); }, 5000);
    const onLine = line => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    lines.once('line', onLine);
    child.stdin.write(text+'\n');
  });
  const rotate=async()=>assert.equal((await command('rotate')).epoch,2);
  return {config, transport, client, input, raw, sourceHash, rotate, command};
}

test('Cloud client and pinned CatsCo peer handler exchange actual HTTPS with strict authority binding', { timeout: 180000 }, async t => {
  const {config,transport,client,input,raw,sourceHash} = await fixture(t);
  const checkError = (kind) => error => error.code === `skillhub.publication_authority_${kind}`;
  const grant = await client.checkUploadGrant(input);
  assert.equal(grant.actorCatsCoUid, '9223372036854775806');
  assert.equal(grant.botUid, '42');
  assert.equal(grant.sourceSnapshotHash, sourceHash);
  assert.equal(grant.requestHash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(grant.requestBytes, raw.length);
  assert.ok(!JSON.stringify(grant).includes('private-'));
  // Each call goes through the real handler; no mock JSON response on Cloud.
  await assert.rejects(client.checkUploadGrant({ ...input, authorityEpoch: 2 }), checkError('inactive'));
  await assert.rejects(client.checkUploadGrant({ ...input, rawBody: Buffer.concat([raw, Buffer.from(' ')]) }), checkError('inactive'));
  await assert.rejects(client.checkUploadGrant({ ...input, token: 'pubupload_' + 'f'.repeat(64) }), checkError('inactive'));
  // Fifth authorized check uses the stable grant but mismatched Cloud key.
  await assert.rejects(client.checkUploadGrant({ ...input, idempotencyKey: 'pubcandidate_' + 'f'.repeat(32) }), checkError('unavailable'));
  await assert.rejects(createPublicationIntrospectionClient({ ...config, peerSecret: 'e'.repeat(64) }, transport).checkUploadGrant(input), checkError('unavailable'));
  await assert.rejects(createPublicationIntrospectionClient(config).checkUploadGrant(input), checkError('unavailable'));
});

test('renewed CatsCo grant recovers the original PostgreSQL intake receipt through actual HTTPS', {timeout:180000}, async t => {
  assert.ok(process.env.SKILLHUB_TEST_DATABASE_URL, 'PostgreSQL DSN is required for renewal contract; missing database is not a skip');
  const peer = await fixture(t);
  const config = loadConfig({databaseUrl:process.env.SKILLHUB_TEST_DATABASE_URL,nodeEnv:'test',publicationTasksEnabled:true});
  const store = createStore(config), suffix=randomUUID();
  let publisher;
  t.after(async () => {
    try {
      if (publisher) {
        await store.query('DELETE FROM publication_delegations WHERE task_id IN (SELECT id FROM publication_tasks WHERE owner_user_id=$1)',[publisher.user.id]);
        await store.query('DELETE FROM users WHERE id=$1',[publisher.user.id]);
      }
    } finally { await closePools(); }
  });
  publisher = await store.claimCatsCoPublisherIdentity({catsCoUid:'9223372036854775806',catsCoIssuer:peer.config.issuer,
    namespace:`renewal-${suffix}`,displayName:'Renewal contract',contact:'',internalEmail:`${suffix}@example.invalid`,passwordHash:'fixture'});
  const accept = () => createDelegatedPublicationIntake({enabled:true,config,store,issuer:peer.config.issuer,
    audience:peer.config.audience,introspectionClient:peer.client});
  const first = await accept()(peer.input);
  assert.equal(first.created,true);
  const before=(await store.query('SELECT * FROM publication_delegations WHERE task_id=$1',[first.association.taskId])).rows[0];
  // Simulate response loss, process reconstruction and token renewal after
  // acceptance. The old token is denied by the real CatsCo HTTP handler.
  await peer.rotate();
  await assert.rejects(accept()(peer.input),{code:'skillhub.publication_authority_inactive'});
  const renewed={...peer.input,token:'pubupload_'+'7'.repeat(64),authorityEpoch:2};
  const recovered=await accept()(renewed);
  assert.equal(recovered.created,false);
  assert.deepEqual(recovered.association,first.association);
  assert.deepEqual((await store.query('SELECT * FROM publication_delegations WHERE task_id=$1',[first.association.taskId])).rows[0],before);
  assert.equal((await store.query('SELECT count(*)::int AS n FROM publication_tasks WHERE owner_user_id=$1',[publisher.user.id])).rows[0].n,1);
  assert.equal((await store.query('SELECT count(*)::int AS n FROM publication_delegation_outbox WHERE task_id=$1',[first.association.taskId])).rows[0].n,1);
  assert.equal(await store.getPublicationRequest(publisher.user.id,first.association.taskId),null);
  await assert.rejects(accept()({...renewed,rawBody:Buffer.concat([renewed.rawBody,Buffer.from(' ')])}),{code:'skillhub.publication_authority_inactive'});
  t.diagnostic('Real Cloud validation/intake/PostgreSQL/client and CatsCo HTTPS handler; CatsCo grant ledger is a rotation-aware test double, not live Bot authority.');
});

test('durable Cloud dispatcher recovers lost HTTPS receipt ACK after restart and local cancellation', {timeout:180000}, async t=>{
  assert.ok(process.env.SKILLHUB_TEST_DATABASE_URL,'PostgreSQL DSN is required; missing database is not a skip');
  const peer=await fixture(t);
  const config=loadConfig({databaseUrl:process.env.SKILLHUB_TEST_DATABASE_URL,nodeEnv:'test',publicationTasksEnabled:true});
  const store=createStore(config),suffix=randomUUID();let publisher;
  t.after(async()=>{
    try{if(publisher){
      await store.query('DELETE FROM publication_delegations WHERE task_id IN (SELECT id FROM publication_tasks WHERE owner_user_id=$1)',[publisher.user.id]);
      await store.query('DELETE FROM users WHERE id=$1',[publisher.user.id]);
    }}finally{await closePools();}
  });
  publisher=await store.claimCatsCoPublisherIdentity({catsCoUid:'9223372036854775806',catsCoIssuer:peer.config.issuer,
    namespace:`receipt-${suffix}`,displayName:'Receipt contract',contact:'',internalEmail:`${suffix}@example.invalid`,passwordHash:'fixture'});
  const accept=createDelegatedPublicationIntake({enabled:true,config,store,issuer:peer.config.issuer,audience:peer.config.audience,introspectionClient:peer.client});
  const first=await accept(peer.input),taskId=first.association.taskId;
  const association=(await store.query('SELECT * FROM publication_delegations WHERE task_id=$1',[taskId])).rows[0];
  const outbox=async()=>(await store.query('SELECT * FROM publication_delegation_outbox WHERE task_id=$1',[taskId])).rows[0];
  const make=()=>createPublicationReceiptDispatcher({...peer.config,store},
    {client:createPublicationReceiptClient(peer.config,peer.transport)});
  await peer.command('lose-ack');const initial=make();await initial.runOnce();await initial.stop();
  assert.equal((await outbox()).delivery_state,'pending');assert.equal((await outbox()).delivery_attempts,1);
  const recorded=await peer.command('receipt');assert.equal(recorded.calls,1);assert.equal(recorded.receipt.TaskID,taskId);
  await peer.rotate();await peer.command('cancel');
  // The raw buffer can expire before response recovery. The same original
  // acceptance bytes/epoch are retained independently of the current grant.
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '2 days',purge_after=now()-interval '1 day' WHERE id=$1",[taskId]);
  await store.maintainPublicationTasks();
  await store.query("UPDATE publication_delegation_outbox SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1",[taskId]);
  const restarted=make();await restarted.runOnce();await restarted.stop();
  const saved=await outbox();assert.equal(saved.delivery_state,'delivered');assert.equal(saved.delivery_attempts,2);assert.equal(saved.local_intent_cancelled,true);
  const replay=await peer.command('receipt');assert.equal(replay.calls,2);assert.deepEqual(replay.receipt,recorded.receipt);
  assert.equal(replay.receipt.Query.Epoch,1);assert.equal(replay.receipt.Query.RequestBytes,peer.raw.length);
  assert.deepEqual((await store.query('SELECT * FROM publication_delegations WHERE task_id=$1',[taskId])).rows[0],association);
  assert.deepEqual((await store.query('SELECT state,candidate,candidate_bytes FROM publication_tasks WHERE id=$1',[taskId])).rows[0],
    {state:'delegated_pending',candidate:null,candidate_bytes:'0'});
  assert.equal(await store.getPublicationRequest(publisher.user.id,taskId),null);
  const receipt={schemaVersion:1,entryRequestId:peer.input.entryRequestId,candidateRevision:1,acceptanceEpoch:1,
    requestHash:association.request_hash??createHash('sha256').update(peer.raw).digest('hex'),sourceSnapshotHash:peer.sourceHash,
    requestBytes:peer.raw.length,delegationId:association.delegation_id,idempotencyKey:peer.input.idempotencyKey,
    taskId,eventId:'pubevent_'+randomUUID()};
  await assert.rejects(createPublicationReceiptClient(peer.config,peer.transport).deliver(receipt),{code:'skillhub.publication_receipt_conflict'});
  t.diagnostic('Real Cloud PostgreSQL lease/retry/cleanup and HTTPS client plus actual CatsCo receipt handler. CatsCo ledger is explicitly a test double; no publication or remote cancellation authority is exercised.');
});
