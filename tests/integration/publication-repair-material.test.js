import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { test, before, after, afterEach } from 'node:test';
import { createPublicationRepairMaterialReader, REPAIR_MATERIAL_MAX_BYTES } from '../../packages/publication-delegation/repair-material.js';
import { createPublicationRepairMaterialHandler, PUBLICATION_REPAIR_MATERIAL_PATH } from '../../apps/api/publication-repair-material.js';
import { createDelegatedPublicationIntake } from '../../packages/publication-delegation/intake.js';
import { createDelegatedPublicationControlStore } from '../../packages/publication-delegation/control-store.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { loadConfig } from '../../packages/config/index.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const issuer = 'https://catsco.invalid', audience = 'https://cloud.invalid';
const secret = 'pubmaterial_' + 'a'.repeat(64);
const id = () => randomUUID().replaceAll('-', '');
const sha = value => createHash('sha256').update(value).digest('hex');
const code = kind => ({ code: `skillhub.publication_repair_material_${kind}` });
const raw = Buffer.from(JSON.stringify({ source: { type: 'files', files: [
  { path: 'SKILL.md', content: '---\nname: material-fixture\n---\nPrivate candidate instructions; not public.' }
] } }));
const validation = validatePublishRequest(raw.toString());
assert.equal(validation.status, 422);
const candidateHash = validation.body.error.validation.candidateHash;
const reference = () => ({ schemaVersion: 1, entryRequestId: 'pubentry_' + id(), candidateRevision: 1,
  acceptanceEpoch: 1, requestHash: sha(raw), sourceSnapshotHash: candidateHash, requestBytes: raw.length,
  delegationId: 'pubgrant_' + id(), idempotencyKey: 'pubcandidate_' + id(),
  taskId: 'pubtask_' + randomUUID(), eventId: 'pubevent_' + randomUUID() });
const row = () => ({ candidate: Buffer.from(raw), candidate_bytes: String(raw.length), intake_result: structuredClone(validation) });
function fakeStore(change = value => value) {
  const calls = [];
  return { calls, tx: async fn => fn({ query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM publication_tasks t')) return { rows: [change(row())].filter(Boolean) };
    if (sql.startsWith('SELECT expires_at')) return { rows: [{ live: true }] };
    return { rows: [] };
  } }) };
}
const reader = (store, extra = {}) => createPublicationRepairMaterialReader({ enabled: true, store, issuer, audience, ...extra });
const httpConfig = extra => ({ publicationRepairMaterial: { enabled: true, issuer, audience, peerSecret: secret,
  trustedProxyAddresses: ['127.0.0.1'], ...extra } });
async function withHTTP(config, store, fn) {
  const handler = createPublicationRepairMaterialHandler(config, store);
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(418); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function send(port, body, { headers = {}, path = PUBLICATION_REPAIR_MATERIAL_PATH, method = 'POST', literal = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      Host: 'cloud.invalid', Authorization: `Bearer ${secret}`, 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', ...headers
    } }, res => {
      const chunks = [];
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('data', chunk => chunks.push(chunk));
    });
    req.on('error', reject); req.end(literal ? body : JSON.stringify(body));
  });
}

test('repair material reader is default off, validates exact original receipts and bounds before SQL', async () => {
  await assert.rejects(createPublicationRepairMaterialReader().read(reference()), code('disabled'));
  await assert.rejects(createPublicationRepairMaterialReader({ enabled: 'true' }).read(reference()), code('disabled'));
  for (const extra of [{ issuer: audience }, { issuer: 'http://catsco.invalid' }, { store: {} }]) {
    assert.throws(() => reader(fakeStore(), extra), code('configuration'));
  }
  const db = fakeStore();
  for (const bad of [null, {}, { ...reference(), actorUID: '85' }, { ...reference(), path: '/private' },
    { ...reference(), requestBytes: REPAIR_MATERIAL_MAX_BYTES + 1 }, { ...reference(), acceptanceEpoch: 9 },
    { ...reference(), requestHash: 'bad' }, { ...reference(), taskId: 'bad' }]) {
    await assert.rejects(reader(db).read(bad), code('invalid'));
  }
  await assert.rejects(reader(db).read(reference(), { signal: AbortSignal.abort() }), code('unavailable'));
  assert.equal(db.calls.length, 0);
});

test('repair material returns exact frozen bytes with no validation rerun or storage writes', async () => {
  const db = fakeStore(), r = reference(), before = { ...r };
  const bytes = await reader(db).read(r);
  assert.deepEqual(bytes, raw); assert.deepEqual(r, before);
  assert.ok(db.calls.every(c => c.sql.startsWith('SELECT') || c.sql.startsWith('SET LOCAL')));
  assert.match(db.calls[2].sql, /FOR SHARE/);
  const select = db.calls.find(c => c.sql.includes('FROM publication_tasks t'));
  assert.deepEqual(select.args, [r.taskId, issuer, audience, r.entryRequestId, 1, 1, r.requestHash,
    r.sourceSnapshotHash, r.requestBytes, r.delegationId, r.idempotencyKey, r.eventId, REPAIR_MATERIAL_MAX_BYTES]);
  bytes.fill(0); assert.deepEqual(await reader(db).read(r), raw);
});

test('repair material refuses corrupt, passed, truncated and missing retained evidence; errors are static', async () => {
  for (const mode of ['missing', 'bytes', 'hash', 'length', 'report', 'passed', 'truncated', 'sql', 'expired']) {
    const db = fakeStore(value => {
      switch (mode) {
        case 'missing': return null;
        case 'bytes': value.candidate = 'private'; break;
        case 'hash': value.candidate = Buffer.alloc(raw.length); break;
        case 'length': value.candidate_bytes++; break;
        case 'report': value.intake_result.body.error.validation.candidateHash = 'f'.repeat(64); break;
        case 'passed': value.intake_result = validatePublishRequest(JSON.stringify({ source: { type: 'files', files: [
          { path: 'SKILL.md', content: '---\nname: material-fixture\ndescription: Read docs.\n---\nPrivate' }
        ] } })); break;
        case 'truncated': value.intake_result.body.error.validation.truncated = true; break;
      }
      return value;
    });
    if (mode === 'sql') db.tx = async () => { throw new Error('PRIVATE SQL credentials source'); };
    if (mode === 'expired') {
      const original = db.tx;
      db.tx = fn => original(c => fn({ query: async (sql, args) => sql.startsWith('SELECT expires_at')
        ? { rows: [{ live: false }] } : c.query(sql, args) }));
    }
    await assert.rejects(reader(db).read(reference()), error => {
      assert.ok(error.code.startsWith('skillhub.publication_repair_material_'));
      assert.equal(error.cause, undefined); assert.ok(!error.message.includes('PRIVATE')); return true;
    }, mode);
  }
});

test('repair material snapshots receipt and bounds abandoned SQL work until settlement', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const base = fakeStore(), db = { tx: async fn => { await barrier; return base.tx(fn); } };
  const read = reader(db), r = reference(), original = { ...r }, controller = new AbortController();
  const first = read.read(r), second = assert.rejects(read.read(reference(), { signal: controller.signal }), code('unavailable'));
  r.taskId = reference().taskId; r.entryRequestId = reference().entryRequestId;
  controller.abort();
  await assert.rejects(read.read(reference()), code('busy'));
  release(); assert.deepEqual(await first, raw); await second;
  assert.equal(base.calls.find(c => c.sql.includes('FROM publication_tasks t')).args[0], original.taskId);
  assert.deepEqual(await read.read(original), raw);
});

test('repair material HTTP is default off, peer only, namespace reserved and errors contain no private bytes', async () => {
  const db = fakeStore(), body = { schemaVersion: 1, receipt: reference() };
  await withHTTP({}, db, async port => {
    assert.equal((await send(port, body)).status, 404);
    assert.equal((await send(port, body, { path: '/api/skills/publication-repair/internal/material?x=1' })).status, 404);
  });
  await withHTTP(httpConfig({ peerSecret: 'wrong' }), db, async port => assert.equal((await send(port, body)).status, 503));
  await withHTTP({ ...httpConfig(), session: { secret } }, db, async port => assert.equal((await send(port, body)).status, 503));
  await withHTTP(httpConfig({ trustedProxyAddresses: [] }), db, async port => assert.equal((await send(port, body)).status, 401));
  await withHTTP(httpConfig(), db, async port => {
    for (const headers of [{ Authorization: 'Bearer pubupload_' + 'a'.repeat(64) }, { Origin: 'https://catsco.invalid' },
      { Cookie: 'session=secret' }, { Host: 'other.invalid' }, { 'X-Forwarded-Proto': 'http' },
      { Authorization: ['Bearer ' + secret, 'Bearer ' + secret] }, { 'X-Forwarded-Proto': ['https', 'https'] }]) {
      assert.equal((await send(port, body, { headers })).status, 401);
    }
    assert.equal((await send(port, body, { method: 'GET' })).status, 405);
    for (const bad of [{ ...body, path: 'SKILL.md' }, { schemaVersion: 1 }, { ...body, schemaVersion: 2 },
      { ...body, receipt: { ...body.receipt, actorCatsCoUid: '85' } }]) assert.equal((await send(port, bad)).status, 400);
    for (const text of ['{"schemaVersion":1,"schemaVersion":1,"receipt":{}}', 'x'.repeat(4097), Buffer.from([255])]) {
      assert.equal((await send(port, text, { literal: true })).status, 400);
    }
    assert.equal((await send(port, body, { headers: { 'Content-Encoding': 'gzip' } })).status, 400);
    assert.equal((await send(port, body, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
    const response = await send(port, body);
    assert.equal(response.status, 200); assert.deepEqual(response.bytes, raw);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['content-length'], String(raw.length));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
  assert.equal(db.calls.filter(c => c.sql.includes('FROM publication_tasks t')).length, 1);
});

test('repair material HTTP holds capacity after disconnect until actual SQL settles', async () => {
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const base = fakeStore(); let inFlight = 0;
  const db = { tx: async fn => { if (++inFlight === 2) entered(); await barrier; return base.tx(fn); } };
  await withHTTP(httpConfig(), db, async port => {
    let abandoned;
    const lost = new Promise(resolve => {
      abandoned = http.request({ host: '127.0.0.1', port, path: PUBLICATION_REPAIR_MATERIAL_PATH, method: 'POST', headers: {
        Host: 'cloud.invalid', Authorization: `Bearer ${secret}`, 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json'
      } });
      abandoned.on('error', resolve); abandoned.end(JSON.stringify({ schemaVersion: 1, receipt: reference() }));
    });
    const waiting = send(port, { schemaVersion: 1, receipt: reference() });
    await ready;
    try {
      assert.equal((await send(port, { schemaVersion: 1, receipt: reference() })).status, 503);
      abandoned.destroy(); await lost;
      assert.equal((await send(port, { schemaVersion: 1, receipt: reference() })).status, 503);
    } finally { release(); }
    assert.equal((await waiting).status, 200);
    assert.equal((await send(port, { schemaVersion: 1, receipt: reference() })).status, 200);
  });
});

test('repair material HTTP rate budget is shared and never allocates caller-controlled buckets', async () => {
  const db = fakeStore(() => null);
  await withHTTP(httpConfig(), db, async port => {
    for (let i = 0; i < 60; i++) assert.equal((await send(port, { schemaVersion: 1, receipt: reference() })).status, 404);
    assert.equal((await send(port, { schemaVersion: 1, receipt: reference() })).status, 429);
  });
  assert.equal(db.calls.filter(c => c.sql.includes('FROM publication_tasks t')).length, 60);
});

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL, pg = { skip: !databaseUrl };
if (process.env.SKILLHUB_REQUIRE_REPAIR_MATERIAL_CONTRACT === '1') assert.ok(databaseUrl, 'real PostgreSQL DSN is mandatory for the repair material contract');
const config = loadConfig({ databaseUrl, nodeEnv: 'test', publicationTasksEnabled: true, publicationPublishingEnabled: true });
let store; const owners = [];
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
    namespace: 'material-' + suffix, displayName: 'Material fixture', contact: '',
    internalEmail: suffix + '@example.invalid', passwordHash: 'fixture' });
  owners.push(identity.user.id);
  const ref = reference();
  const input = { rawBody: raw, sourceSnapshotHash: ref.sourceSnapshotHash, entryRequestId: ref.entryRequestId,
    token: 'pubupload_' + id() + id(), idempotencyKey: ref.idempotencyKey, authorityEpoch: 1 };
  const accept = createDelegatedPublicationIntake({ enabled: true, config, store, issuer, audience,
    introspectionClient: { async checkUploadGrant(r) { return { issuer, audience, action: 'candidate.upload', actorCatsCoUid: actor,
      botUid: '999', entryRequestId: r.entryRequestId, candidateRevision: 1, authorityEpoch: r.authorityEpoch,
      requestHash: sha(r.rawBody), requestBytes: r.rawBody.length, sourceSnapshotHash: r.sourceSnapshotHash,
      idempotencyKey: r.idempotencyKey, delegationId: ref.delegationId,
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90000).toISOString() }; } } });
  const { association } = await accept(input);
  return { owner: identity.user.id, actor, receipt: { ...ref, taskId: association.taskId, eventId: association.eventId } };
}
const task = async f => (await store.query('SELECT * FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0];

test('PostgreSQL repair material reads exact retained rejection across restart and loses no state on response loss', pg, async t => {
  const f = await fixture(), original = await task(f), tls = await publicationPeerTLS();
  let handler = createPublicationRepairMaterialHandler(httpConfig({ trustedProxyAddresses: [] }), store), lose = true;
  const server = https.createServer(tls, async (req, res) => {
    const end = res.end.bind(res);
    res.end = (...args) => { if (lose && res.statusCode === 200) { lose = false; res.destroy(); return res; } return end(...args); };
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await tls.close(); });
  const sendTLS = () => new Promise((resolve, reject) => {
    const req = https.request(`https://127.0.0.1:${server.address().port}${PUBLICATION_REPAIR_MATERIAL_PATH}`, {
      method: 'POST', ca: tls.cert, servername: 'localhost', agent: false,
      headers: { Host: 'cloud.invalid', Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
    }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject); req.end(JSON.stringify({ schemaVersion: 1, receipt: f.receipt }));
  });
  await assert.rejects(sendTLS(), { code: 'ECONNRESET' });
  assert.deepEqual(await task(f), original);
  handler = createPublicationRepairMaterialHandler(httpConfig({ trustedProxyAddresses: [] }), createStore(config));
  const replay = await sendTLS();
  assert.equal(replay.status, 200); assert.deepEqual(replay.bytes, raw);
  assert.equal(replay.headers['cache-control'], 'no-store');
  for (const bytes of await Promise.all(Array.from({ length: 4 }, () => reader(store).read(f.receipt)))) assert.deepEqual(bytes, raw);
  assert.deepEqual(await task(f), original);
  assert.equal((await store.query('SELECT count(*)::int AS n FROM publication_commits WHERE task_id=$1', [f.receipt.taskId])).rows[0].n, 0);
  t.diagnostic('real TLS + PostgreSQL private original candidate read: lost response, reconstructed reader, identical raw bytes and unchanged rejected task; no model or Runtime source check');
});

test('PostgreSQL repair material matches every receipt field and issuer/audience before returning bytes', pg, async () => {
  const f = await fixture(), original = await task(f), other = reference();
  for (const key of ['entryRequestId', 'taskId', 'eventId', 'delegationId', 'idempotencyKey', 'requestHash', 'sourceSnapshotHash']) {
    await assert.rejects(reader(store).read({ ...f.receipt, [key]: other[key] === f.receipt[key] ? 'f'.repeat(64) : other[key] }), code('not_found'));
  }
  for (const change of [{ acceptanceEpoch: 2 }, { requestBytes: raw.length + 1 }]) {
    await assert.rejects(reader(store).read({ ...f.receipt, ...change }), code('not_found'));
  }
  for (const scope of [{ issuer: 'https://other.invalid' }, { audience: 'https://other.invalid' }]) {
    await assert.rejects(reader(store, scope).read(f.receipt), code('not_found'));
  }
  assert.deepEqual(await task(f), original);
});

test('PostgreSQL repair material denies changed current publisher, expiry and cancellation unlike historical report reads', pg, async () => {
  for (const change of ['user', 'profile', 'namespace', 'actor', 'issuer', 'expired', 'cancelled']) {
    const f = await fixture();
    if (change === 'user') await store.query("UPDATE users SET status='disabled' WHERE id=$1", [f.owner]);
    if (change === 'profile') await store.query("UPDATE publisher_profiles SET status='disabled' WHERE user_id=$1", [f.owner]);
    if (change === 'namespace') await store.query("UPDATE publisher_profiles SET namespace=namespace||'-new' WHERE user_id=$1", [f.owner]);
    if (change === 'actor') await store.query("UPDATE publisher_profiles SET catsco_uid=catsco_uid||'1' WHERE user_id=$1", [f.owner]);
    if (change === 'issuer') await store.query("UPDATE publisher_profiles SET catsco_issuer='https://other.invalid' WHERE user_id=$1", [f.owner]);
    if (change === 'expired') await store.query("UPDATE publication_tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [f.receipt.taskId]);
    if (change === 'cancelled') await createDelegatedPublicationControlStore({ enabled: true, store, issuer, audience }).cancel(f.receipt);
    const before = await task(f);
    await assert.rejects(reader(store).read(f.receipt), code('not_found'), change);
    assert.deepEqual(await task(f), before);
  }
});

test('PostgreSQL repair material task lock serializes with cancellation in either order', pg, async () => {
  for (const firstAction of ['read', 'cancel']) {
    const f = await fixture(); let locked, release;
    const acquired = new Promise(resolve => { locked = resolve; }), barrier = new Promise(resolve => { release = resolve; });
    const held = { tx: fn => store.tx(c => fn({ query: async (sql, args) => {
      const result = await c.query(sql, args);
      if ((sql.includes('FOR SHARE') && sql.startsWith('SELECT id')) || (firstAction === 'cancel' && sql.includes('FROM publication_tasks t'))) {
        locked(); await barrier;
      }
      return result;
    } })) };
    const control = s => createDelegatedPublicationControlStore({ enabled: true, store: s, issuer, audience });
    const first = firstAction === 'read' ? reader(held).read(f.receipt) : control(held).cancel(f.receipt);
    await acquired;
    const second = firstAction === 'read' ? control(store).cancel(f.receipt)
      : assert.rejects(reader(store).read(f.receipt), code('not_found'));
    release();
    const [result] = await Promise.all([first, second]);
    if (firstAction === 'read') assert.deepEqual(result, raw);
    assert.equal((await task(f)).state, 'cancelled');
    await assert.rejects(reader(store).read(f.receipt), code('not_found'));
  }
});
