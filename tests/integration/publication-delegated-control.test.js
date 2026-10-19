import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, afterEach, test } from 'node:test';
import { createDelegatedPublicationControlStore } from '../../packages/publication-delegation/control-store.js';
import { createDelegatedPublicationIntake } from '../../packages/publication-delegation/intake.js';
import { createPublicationReceiptStore } from '../../packages/publication-delegation/receipt-store.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { loadConfig } from '../../packages/config/index.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import https from 'node:https';
import { createPublicationControlHandler, PUBLICATION_CONTROL_PATH } from '../../apps/api/publication-control.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const issuer = 'https://control.invalid', audience = 'https://cloud.invalid';
const id = () => randomUUID().replaceAll('-', '');
const hash = b => createHash('sha256').update(b).digest('hex');
const code = kind => ({ code: `skillhub.publication_control_${kind}` });
const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL, pg = { skip: !databaseUrl };
const config = loadConfig({ databaseUrl, nodeEnv: 'test', publicationTasksEnabled: true, publicationPublishingEnabled: true });
const settings = publicationTaskSettings(config);
const reference = () => ({ schemaVersion: 1, entryRequestId: `pubentry_${id()}`, candidateRevision: 1,
  acceptanceEpoch: 1, requestHash: 'a'.repeat(64), sourceSnapshotHash: 'b'.repeat(64), requestBytes: 1,
  delegationId: `pubgrant_${id()}`, idempotencyKey: `pubcandidate_${id()}`,
  taskId: `pubtask_${randomUUID()}`, eventId: `pubevent_${randomUUID()}` });
const control = (s, extra = {}) => createDelegatedPublicationControlStore({ enabled: true, store: s, issuer, audience, ...extra });

test('delegated control is default-off and requires strict historical references, not credentials or identity overrides', async () => {
  for (const action of ['read', 'cancel']) {
    await assert.rejects(createDelegatedPublicationControlStore()[action](reference()), code('disabled'));
    await assert.rejects(createDelegatedPublicationControlStore({ enabled: 'true' })[action](reference()), code('disabled'));
  }
  for (const override of [{ issuer: 'http://bad.invalid' }, { audience: issuer }, { store: {} }]) {
    assert.throws(() => control({ tx() {} }, override), code('configuration'));
  }
  let calls = 0;
  const c = control({ tx() { calls++; throw new Error('SQL must not run'); } });
  for (const r of [null, {}, { ...reference(), actorCatsCoUid: '85' }, { ...reference(), token: 'secret' },
    { ...reference(), acceptanceEpoch: 9 }, { ...reference(), taskId: 'bad' },
    { ...reference(), eventId: reference().eventId + '\n' }, { ...reference(), requestBytes: 0 }]) {
    await assert.rejects(c.read(r), code('invalid'));
    await assert.rejects(c.cancel(r), code('invalid'));
  }
  assert.equal(calls, 0);
});

test('delegated control bounds in-flight SQL and redacts errors until actual settlement', async () => {
  const releases = [];
  const c = control({ tx: () => new Promise((_, reject) => releases.push(reject)) });
  const pending = Array.from({ length: 16 }, () => assert.rejects(c.read(reference()), e => {
    assert.equal(e.code, code('storage').code);
    assert.ok(!e.message.includes('private')); assert.equal(e.cause, undefined); return true;
  }));
  await assert.rejects(c.cancel(reference()), code('busy'));
  for (const reject of releases) reject(new Error('private SQL candidate credentials'));
  await Promise.all(pending);
  const again = assert.rejects(c.cancel(reference()), code('storage'));
  releases.at(-1)(new Error('private')); await again;
});

test('delegated control snapshots reference before await and fails closed for future execution evidence', async () => {
  const r = reference(), original = { ...r };
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const calls = [];
  const c = control({ tx: async fn => {
    await barrier;
    return fn({ query: async (sql, args) => {
      calls.push(sql);
      if (sql.includes('FROM publication_tasks t')) {
        assert.equal(args[0], original.taskId); assert.equal(args[3], original.entryRequestId);
        return { rows: [{ state: 'committing' }] };
      }
      return { rowCount: 0, rows: [] };
    } });
  } });
  const pending = assert.rejects(c.cancel(r), code('conflict'));
  r.taskId = reference().taskId; r.entryRequestId = reference().entryRequestId;
  release(); await pending;
  assert.ok(!calls.some(sql => sql.startsWith('UPDATE')));
});

let store;
const owners = [];
before(() => { if (databaseUrl) store = createStore(config); });
afterEach(async () => {
  if (!store) return;
  for (const owner of owners.splice(0)) {
    await store.query('DELETE FROM publication_delegations WHERE task_id IN (SELECT id FROM publication_tasks WHERE owner_user_id=$1)', [owner]);
    await store.query('DELETE FROM users WHERE id=$1', [owner]);
  }
});
after(closePools);
async function fixture() {
  const suffix = id(), actor = String(BigInt('0x' + suffix.slice(0, 12)) + 1000n);
  const identity = await store.claimCatsCoPublisherIdentity({ catsCoUid: actor, catsCoIssuer: issuer,
    namespace: `control-${suffix}`, displayName: 'Control fixture', contact: '',
    internalEmail: `${suffix}@example.invalid`, passwordHash: 'fixture' });
  owners.push(identity.user.id);
  const rawBody = Buffer.from(JSON.stringify({ source: { type: 'files', files: [{ path: 'SKILL.md',
    content: '---\nname: control-test\ndescription: Fixture only\n---\nPrivate source' }] } }));
  const input = { rawBody, sourceSnapshotHash: validatePublishRequest(rawBody.toString()).body.validation.candidateHash,
    entryRequestId: `pubentry_${id()}`, token: `pubupload_${id() + id()}`, idempotencyKey: `pubcandidate_${id()}`, authorityEpoch: 1 };
  const accept = createDelegatedPublicationIntake({ enabled: true, config, store, issuer, audience,
    introspectionClient: { async checkUploadGrant(r) {
      return { issuer, audience, action: 'candidate.upload', actorCatsCoUid: actor, botUid: '999',
        entryRequestId: r.entryRequestId, candidateRevision: 1, authorityEpoch: r.authorityEpoch,
        requestHash: hash(r.rawBody), requestBytes: r.rawBody.length, sourceSnapshotHash: r.sourceSnapshotHash,
        idempotencyKey: r.idempotencyKey, delegationId: r.entryRequestId.replace('pubentry_', 'pubgrant_'),
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90000).toISOString() };
    } } });
  const { association } = await accept(input);
  const receipt = { schemaVersion: 1, entryRequestId: input.entryRequestId, candidateRevision: 1,
    acceptanceEpoch: 1, requestHash: hash(rawBody), sourceSnapshotHash: input.sourceSnapshotHash,
    requestBytes: rawBody.length, delegationId: input.entryRequestId.replace('pubentry_', 'pubgrant_'),
    idempotencyKey: input.idempotencyKey, taskId: association.taskId, eventId: association.eventId };
  return { owner: identity.user.id, profile: identity.developerProfile, input, accept, receipt };
}
const task = async f => (await store.query('SELECT * FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0];

test('PostgreSQL authenticated control HTTP recovers lost cancellation responses and never restores candidate bytes', pg, async t => {
  const f = await fixture(), tls = await publicationPeerTLS();
  let handler, lose = true;
  const server = https.createServer(tls, async (req, res) => {
    // Lose only the response after the actual handler/store committed.
    const end = res.end.bind(res);
    res.end = (...args) => { if (lose && res.statusCode === 200) { lose = false; res.destroy(); return res; } return end(...args); };
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await tls.close(); });
  const origin = `https://127.0.0.1:${server.address().port}`, peerSecret = '9'.repeat(64);
  // Trusted proxy rewrites Host in production; this fixture uses direct TLS
  // with the fixed historical audience in Host and the test CA for transport.
  const settings = { enabled: true, issuer, audience, peerSecret, trustedProxyAddresses: [] };
  const restart = () => { handler = createPublicationControlHandler({ publicationControl: settings }, createStore(config)); };
  restart();
  const cancellationId = `pubcancel_${id()}`;
  const send = (action = 'cancel', reference = f.receipt, token = peerSecret) => new Promise((resolve, reject) => {
    const req = https.request(origin + PUBLICATION_CONTROL_PATH, { method: 'POST', ca: tls.cert, servername: 'localhost', agent: false,
      headers: { Host: new URL(audience).host, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ schemaVersion: 1, action, receipt: reference, ...(action === 'cancel' ? { cancellationId } : {}) }));
  });
  assert.equal((await send('cancel', f.receipt, '8'.repeat(64))).status, 401);
  assert.equal((await task(f)).state, 'delegated_pending');
  await assert.rejects(send(), { code: 'ECONNRESET' });
  const afterLost = await task(f);
  assert.equal(afterLost.state, 'cancelled'); assert.equal(afterLost.candidate, null);
  restart();
  const replay = await send();
  assert.equal(replay.status, 200); assert.equal(replay.body.cancellationId, cancellationId);
  assert.equal(replay.body.executionState, 'cancelled');
  assert.equal(replay.body.cancelledAt, new Date(afterLost.delegated_cancelled_at).toISOString());
  assert.equal((await send('read')).body.cancelledAt, replay.body.cancelledAt);
  assert.equal((await send('cancel', { ...f.receipt, eventId: reference().eventId })).status, 404);
  assert.deepEqual(await task(f), afterLost);
  assert.equal((await f.accept({ ...f.input, authorityEpoch: 2 })).association.state, 'cancelled');
});

test('PostgreSQL delegated cancel is durable and idempotent; reads do not mutate and replies are bounded', pg, async () => {
  const f = await fixture(), c = control(store), before = await task(f);
  const pending = await c.read(f.receipt);
  assert.equal(pending.executionState, 'delegated_pending'); assert.equal(pending.candidateAvailable, true);
  assert.equal(pending.cancelledAt, null); assert.deepEqual(await task(f), before);
  const results = await Promise.all(Array.from({ length: 8 }, () => c.cancel(f.receipt)));
  assert.equal(new Set(results.map(r => r.cancelledAt)).size, 1);
  for (const result of results) {
    assert.equal(result.executionState, 'cancelled'); assert.equal(result.candidateAvailable, false);
    assert.ok(Date.parse(result.cancelledAt) <= Date.parse(result.observedAt));
  }
  const saved = await task(f);
  assert.equal(saved.candidate, null); assert.equal(saved.candidate_bytes, '0'); assert.equal(saved.authority_kind, 'catsco');
  const restart = control(createStore(config));
  assert.equal((await restart.cancel(f.receipt)).cancelledAt, results[0].cancelledAt);
  assert.equal((await restart.read(f.receipt)).executionState, 'cancelled');
  assert.deepEqual(await task(f), saved);
  const text = JSON.stringify(results[0]);
  assert.ok(Buffer.byteLength(text) < 1024);
  for (const secret of ['Private source', 'SKILL.md', f.input.token, f.input.idempotencyKey,
    f.owner, f.receipt.delegationId, f.receipt.requestHash]) assert.ok(!text.includes(secret));
  assert.equal((await store.query('SELECT count(*)::int AS n FROM publication_commits WHERE task_id=$1', [f.receipt.taskId])).rows[0].n, 0);
});

test('PostgreSQL delegated control matches every retained field and peer scope before reading or cancelling', pg, async () => {
  const f = await fixture(), c = control(store), alternate = reference();
  for (const key of ['entryRequestId', 'taskId', 'eventId', 'delegationId', 'idempotencyKey', 'requestHash', 'sourceSnapshotHash']) {
    for (const action of ['read', 'cancel']) await assert.rejects(c[action]({ ...f.receipt, [key]: alternate[key] }), code('not_found'));
  }
  for (const change of [{ acceptanceEpoch: 2 }, { requestBytes: f.receipt.requestBytes + 1 }]) {
    await assert.rejects(c.cancel({ ...f.receipt, ...change }), code('not_found'));
  }
  for (const scope of [{ issuer: 'https://other.invalid' }, { audience: 'https://other.invalid' }]) {
    await assert.rejects(control(store, scope).cancel(f.receipt), code('not_found'));
  }
  assert.equal((await task(f)).state, 'delegated_pending');
});

test('PostgreSQL cancellation survives expiry and disabled or renamed publishers without assuming new authority', pg, async () => {
  const f = await fixture(), c = control(store);
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '2 days',purge_after=now()-interval '1 day' WHERE id=$1", [f.receipt.taskId]);
  assert.equal((await c.read(f.receipt)).candidateAvailable, false);
  await store.maintainPublicationTasks();
  await store.query("UPDATE users SET status='disabled' WHERE id=$1", [f.owner]);
  await store.query("UPDATE publisher_profiles SET namespace=namespace||'-changed',status='disabled' WHERE user_id=$1", [f.owner]);
  assert.equal((await c.cancel(f.receipt)).executionState, 'cancelled');
  await store.maintainPublicationTasks();
  assert.equal((await c.read(f.receipt)).executionState, 'cancelled');
  assert.equal((await task(f)).candidate, null);
  await assert.rejects(store.query('DELETE FROM publication_tasks WHERE id=$1', [f.receipt.taskId]), { code: '23503' });
});

test('PostgreSQL cancelled task replay and concurrent intake cannot resurrect source or allocate a replacement', pg, async () => {
  const f = await fixture(), c = control(store);
  const racing = await Promise.all([f.accept({ ...f.input, authorityEpoch: 2 }), c.cancel(f.receipt)]);
  assert.equal(racing[0].association.taskId, f.receipt.taskId);
  assert.ok(['delegated_pending', 'cancelled'].includes(racing[0].association.state));
  for (let epoch = 2; epoch <= 4; epoch++) {
    const replay = await f.accept({ ...f.input, authorityEpoch: epoch, token: `pubupload_${id() + id()}` });
    assert.equal(replay.created, false); assert.equal(replay.association.state, 'cancelled');
    assert.equal(replay.association.candidateAvailable, false); assert.equal(replay.association.authorityEpoch, 1);
    assert.equal(replay.association.taskId, f.receipt.taskId); assert.equal(replay.association.eventId, f.receipt.eventId);
  }
  const row = await task(f); assert.equal(row.state, 'cancelled'); assert.equal(row.candidate, null);
  assert.equal((await store.query('SELECT count(*)::int AS n FROM publication_tasks WHERE owner_user_id=$1', [f.owner])).rows[0].n, 1);
});

test('PostgreSQL task lock serializes reads and cancellation in both orders', pg, async () => {
  for (const firstAction of ['read', 'cancel']) {
    const f = await fixture();
    let locked, release;
    const acquired = new Promise(resolve => { locked = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const held = { tx: fn => store.tx(c => fn({ query: async (sql, args) => {
      const result = await c.query(sql, args);
      if (sql.includes('FROM publication_tasks t')) { locked(); await barrier; }
      return result;
    } })) };
    const first = control(held)[firstAction](f.receipt);
    await acquired;
    const second = control(store)[firstAction === 'read' ? 'cancel' : 'read'](f.receipt);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.executionState, firstAction === 'read' ? 'delegated_pending' : 'cancelled');
    assert.equal(b.executionState, 'cancelled');
    assert.equal((await control(store).read(f.receipt)).executionState, 'cancelled');
  }
});

test('PostgreSQL cancelled acceptance still delivers original receipt before or after an in-flight ACK', pg, async () => {
  const f = await fixture(), c = control(store), ledger = createPublicationReceiptStore(store, { issuer, audience });
  await c.cancel(f.receipt);
  const first = await ledger.claim(); assert.deepEqual(first.receipt, f.receipt);
  await ledger.finish(first, { kind: 'retry' });
  await store.query("UPDATE publication_delegation_outbox SET next_attempt_at=now()-interval '1 second' WHERE task_id=$1", [f.receipt.taskId]);
  const second = await createPublicationReceiptStore(createStore(config), { issuer, audience }).claim();
  assert.deepEqual(second.receipt, first.receipt);
  await ledger.finish(second, { kind: 'delivered', localIntentCancelled: false });
  assert.equal((await c.read(f.receipt)).executionState, 'cancelled');
  const next = await fixture(), leased = await ledger.claim();
  assert.equal(leased.receipt.taskId, next.receipt.taskId);
  await c.cancel(next.receipt);
  assert.equal(await ledger.finish(leased, { kind: 'delivered', localIntentCancelled: false }), true);
  assert.equal((await c.read(next.receipt)).executionState, 'cancelled');
});

test('PostgreSQL SQL failure after cancellation write rolls back and uncertain completion is recoverable', pg, async () => {
  const f = await fixture();
  const broken = { tx: fn => store.tx(c => fn({ query: (sql, args) => {
    if (sql === 'SELECT clock_timestamp() AS observed_at') throw new Error('private database path');
    return c.query(sql, args);
  } })) };
  await assert.rejects(control(broken).cancel(f.receipt), code('storage'));
  assert.equal((await task(f)).state, 'delegated_pending'); assert.deepEqual((await task(f)).candidate, f.input.rawBody);
  const lostReply = { tx: async fn => { await store.tx(fn); throw new Error('lost completion'); } };
  await assert.rejects(control(lostReply).cancel(f.receipt), code('storage'));
  const saved = await task(f);
  assert.equal(saved.state, 'cancelled');
  assert.equal((await control(store).cancel(f.receipt)).cancelledAt, saved.delegated_cancelled_at.toISOString());
});

const commitSQL = `INSERT INTO publication_commits(task_id,profile_id,namespace,confirm_version,manifest,identity,scan_id,package_id)
  VALUES($1,'profile','namespace',false,'{}','{}',$2,$3)`;
test('PostgreSQL schema forbids resurrection and delegated commit records; ordinary tasks remain usable', pg, async () => {
  const f = await fixture();
  await assert.rejects(store.query(commitSQL, [f.receipt.taskId, id(), id()]), { code: '23514' });
  await control(store).cancel(f.receipt);
  for (const update of ["state='delegated_pending',delegated_cancelled_at=NULL", "delegated_cancelled_at=now()-interval '1 day'",
    "candidate=decode('ff','hex'),candidate_bytes=1", "authority_kind='account',delegated_cancelled_at=NULL",
    "state='committing'", "publication_result='{}'", `lease_token='${randomUUID()}'`]) {
    await assert.rejects(store.query(`UPDATE publication_tasks SET ${update} WHERE id=$1`, [f.receipt.taskId]), { code: '23514' });
  }
  await assert.rejects(store.query(commitSQL, [f.receipt.taskId, id(), id()]), { code: '23514' });
  assert.equal(await store.getPublicationTask(f.owner, f.receipt.taskId), null);
  assert.equal(await store.cancelPublicationTask(f.owner, f.receipt.taskId), null);
  await assert.rejects(store.enqueuePublicationCommit({ ownerId: f.owner, id: f.receipt.taskId,
    profile: f.profile, candidateHash: f.input.sourceSnapshotHash }), { status: 404 });
  assert.equal(await store.claimPublicationTask(settings), null); assert.equal(await store.claimPublicationCommit(settings), null);
  const ordinary = await store.createPublicationTask({ ownerId: f.owner, requestKey: `ordinary-${id()}`,
    requestHash: hash(f.input.rawBody), candidateHash: f.input.sourceSnapshotHash, candidate: f.input.rawBody,
    result: validatePublishRequest(f.input.rawBody.toString()), settings });
  assert.equal((await store.claimPublicationTask(settings)).id, ordinary.task.id);
  await store.query(commitSQL, [ordinary.task.id, id(), id()]);
  await assert.rejects(store.query('UPDATE publication_commits SET task_id=$1 WHERE task_id=$2',
    [f.receipt.taskId, ordinary.task.id]), { code: '23514' });
  assert.equal((await store.cancelPublicationTask(f.owner, ordinary.task.id)).state, 'cancelled');
});

test('PostgreSQL migration018 upgrades held and ordinary data without altering evidence', pg, async () => {
  const files = ['012_publication_tasks.sql', '014_publication_commits.sql', '016_delegated_publication_intake.sql',
    '017_publication_receipt_delivery.sql', '018_delegated_publication_cancellation.sql'];
  const migrations = await Promise.all(files.map(name => readFile(new URL(`../../infra/migrations/${name}`, import.meta.url), 'utf8')));
  const schema = `control_migration_${id()}`;
  await store.tx(async c => {
    await c.query(`CREATE SCHEMA ${schema}`); await c.query(`SET LOCAL search_path TO ${schema}`);
    await c.query("CREATE TABLE users(id text PRIMARY KEY); INSERT INTO users VALUES('owner')");
    for (const migration of migrations.slice(0, -1)) await c.query(migration);
    const r = reference();
    for (const [taskId, authority, state] of [[r.taskId, 'catsco', 'delegated_pending'], ['ordinary', 'account', 'queued']]) {
      await c.query(`INSERT INTO publication_tasks(id,owner_user_id,request_key,request_hash,candidate_hash,candidate,candidate_bytes,
        state,intake_result,expires_at,purge_after,authority_kind)
        VALUES($1,'owner',$2,$3,$4,$5,1,$6,'{}',now()+interval '1 day',now()+interval '2 days',$7)`,
      [taskId, taskId === r.taskId ? r.idempotencyKey : 'account-key', r.requestHash, r.sourceSnapshotHash, Buffer.from('x'), state, authority]);
    }
    await c.query(`INSERT INTO publication_delegations(task_id,issuer,audience,entry_request_id,candidate_revision,actor_uid,bot_uid,
      profile_id,namespace,delegation_id,authority_epoch,request_bytes) VALUES($1,$2,$3,$4,1,'1','2','profile','namespace',$5,1,1)`,
    [r.taskId, issuer, audience, r.entryRequestId, r.delegationId]);
    await c.query('INSERT INTO publication_delegation_outbox(task_id,event_id) VALUES($1,$2)', [r.taskId, r.eventId]);
    await c.query(commitSQL, ['ordinary', id(), id()]);
    const before = (await c.query('SELECT * FROM publication_tasks ORDER BY id')).rows;
    const evidence = (await c.query('SELECT * FROM publication_delegations')).rows;
    await c.query(migrations.at(-1));
    const after = (await c.query('SELECT * FROM publication_tasks ORDER BY id')).rows;
    assert.deepEqual(after.map(({ delegated_cancelled_at, ...row }) => { assert.equal(delegated_cancelled_at, null); return row; }), before);
    assert.deepEqual((await c.query('SELECT * FROM publication_delegations')).rows, evidence);
    const scoped = control({ tx: fn => fn(c) });
    assert.equal((await scoped.cancel(r)).executionState, 'cancelled');
    assert.equal((await scoped.cancel(r)).executionState, 'cancelled');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM publication_commits WHERE task_id='ordinary'")).rows[0].n, 1);
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
  });
});
