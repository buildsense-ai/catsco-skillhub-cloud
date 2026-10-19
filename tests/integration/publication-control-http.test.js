import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicationControlHandler, PUBLICATION_CONTROL_PATH } from '../../apps/api/publication-control.js';
import { PublicationControlError } from '../../packages/publication-delegation/control-store.js';
import { createApiServer } from '../../apps/api/server.js';
import { loadConfig } from '../../packages/config/index.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const secret = '1'.repeat(64);
const receipt = () => ({ schemaVersion: 1, entryRequestId: 'pubentry_' + '2'.repeat(32), candidateRevision: 1,
  acceptanceEpoch: 1, requestHash: '3'.repeat(64), sourceSnapshotHash: '4'.repeat(64), requestBytes: 123,
  delegationId: 'pubgrant_' + '5'.repeat(32), idempotencyKey: 'pubcandidate_' + '6'.repeat(32),
  taskId: 'pubtask_12345678-1234-4123-8123-123456789abc', eventId: 'pubevent_12345678-1234-4123-8123-123456789abc' });
const input = (action = 'cancel') => ({ schemaVersion: 1, action, receipt: receipt(),
  ...(action === 'cancel' ? { cancellationId: 'pubcancel_' + '7'.repeat(32) } : {}) });
const observation = (r, cancelled = false) => ({ schemaVersion: 1, entryRequestId: r.entryRequestId, taskId: r.taskId,
  candidateRevision: 1, executionState: cancelled ? 'cancelled' : 'delegated_pending', candidateAvailable: !cancelled,
  cancelledAt: cancelled ? '2026-10-19T00:00:00.000Z' : null, observedAt: '2026-10-19T00:00:01.000Z' });
let tls;
before(async () => { tls = await publicationPeerTLS(); });
after(async () => { await tls?.close(); });

async function fixture(t, { plain = false, settings = {}, control, timeoutMs } = {}) {
  let handler;
  const calls = [];
  control ??= { async read(r) { calls.push(['read', r]); return observation(r); },
    async cancel(r) { calls.push(['cancel', r]); return observation(r, true); } };
  const server = (plain ? http : https).createServer(...(plain ? [] : [tls]), (req, res) => {
    void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const address = `127.0.0.1:${server.address().port}`;
  const config = { publicationControl: { enabled: true, issuer: 'https://catsco.example', audience: `https://${address}`,
    peerSecret: secret, trustedProxyAddresses: [], ...settings } };
  handler = createPublicationControlHandler(config, {}, { control, ...(timeoutMs ? { timeoutMs } : {}) });
  const send = (body = input(), { headers = {}, method = 'POST', path = PUBLICATION_CONTROL_PATH, idle = false } = {}) => new Promise((resolve, reject) => {
    const bytes = typeof body === 'string' ? body : JSON.stringify(body);
    const req = (plain ? http : https).request(`${plain ? 'http' : 'https'}://${address}${path}`, {
      method, ca: tls.cert, servername: 'localhost', agent: false, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers }
    }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('error', reject);
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }); req.destroy(); });
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('test request timed out')));
    if (idle) req.flushHeaders(); else req.end(bytes);
  });
  return { calls, send, config, address };
}

test('control HTTP authenticates a dedicated service and returns exact bounded cancel/read correlation', async t => {
  const f = await fixture(t);
  for (const action of ['read', 'cancel', 'cancel']) {
    const r = await f.send(input(action));
    assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.deepEqual(r.body, { ...observation(receipt(), action === 'cancel'), action,
      eventId: receipt().eventId, cancellationId: action === 'cancel' ? input().cancellationId : null });
    for (const key of ['requestHash', 'sourceSnapshotHash', 'delegationId', 'idempotencyKey']) assert.ok(!JSON.stringify(r.body).includes(receipt()[key]));
  }
  assert.equal(f.calls.length, 3);
});

test('control HTTP default off, invalid configuration and reserved route fail closed', async t => {
  for (const settings of [{ enabled: false }, { issuer: 'http://bad' }, { peerSecret: 'short' }, { trustedProxyAddresses: ['*'] }]) {
    const f = await fixture(t, { settings });
    assert.equal((await f.send()).status, settings.enabled === false ? 404 : 503); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  for (const path of [PUBLICATION_CONTROL_PATH + '?token=x', PUBLICATION_CONTROL_PATH + '/', PUBLICATION_CONTROL_PATH.replace('control', '%63ontrol')]) {
    assert.equal((await f.send(input(), { path })).status, 404);
  }
  for (const method of ['GET', 'OPTIONS', 'DELETE']) assert.equal((await f.send(input(), { method })).status, 405);
  assert.equal(f.calls.length, 0);
});

test('control HTTP rejects account/upload credentials, duplicate auth, browser context and host confusion', async t => {
  const f = await fixture(t);
  for (const headers of [ { Authorization: '' }, { Authorization: 'Bearer pubupload_' + secret },
    { Authorization: 'Bearer account-session' }, { Authorization: [`Bearer ${secret}`, `Bearer ${secret}`] },
    { Cookie: 'catsco_session=example' }, { Origin: 'https://catsco.example' }, { Host: 'other.example' } ]) {
    assert.equal((await f.send(input(), { headers })).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('control HTTP trusts forwarded TLS only from an explicitly configured socket peer', async t => {
  const f = await fixture(t, { plain: true });
  assert.equal((await f.send()).status, 401);
  assert.equal((await f.send(input(), { headers: { 'X-Forwarded-Proto': 'https' } })).status, 401);
  const proxy = await fixture(t, { plain: true, settings: { trustedProxyAddresses: ['127.0.0.1'] } });
  assert.equal((await proxy.send()).status, 401);
  assert.equal((await proxy.send(input(), { headers: { 'X-Forwarded-Proto': 'https,http' } })).status, 401);
  assert.equal((await proxy.send(input(), { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
});

test('control HTTP rejects duplicate JSON, extra authority fields, invalid references and oversized or encoded bodies', async t => {
  const f = await fixture(t);
  const invalid = [null, [], {}, { ...input(), actorUid: '85' }, { ...input(), cancellationId: input().cancellationId + '\n' },
    { ...input('read'), cancellationId: input().cancellationId }, { ...input(), receipt: { ...receipt(), token: 'private' } },
    { ...input(), receipt: { ...receipt(), acceptanceEpoch: 9 } }, JSON.stringify(input()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    'x'.repeat(4097)];
  for (const body of invalid) assert.equal((await f.send(body)).status, 400);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }, { 'Content-Length': '4097' }]) {
    assert.equal((await f.send(input(), { headers })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('control HTTP safe error mapping distinguishes unknown, conflict and indeterminate storage outcomes', async t => {
  for (const [error, status] of [[new PublicationControlError('not_found'), 404], [new PublicationControlError('conflict'), 409],
    [new Error('SQL private candidate token password'), 503]]) {
    const f = await fixture(t, { control: { cancel: async () => { throw error; } } });
    const result = await f.send(); assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes('password'));
  }
});

test('control HTTP times out idle bodies without executing storage', async t => {
  const f = await fixture(t, { timeoutMs: 40 });
  assert.equal((await f.send(input(), { idle: true, headers: { 'Content-Length': '500' } })).status, 503);
  assert.equal(f.calls.length, 0);
});

test('control HTTP retains admission slots until timed-out storage settles', async t => {
  const releases = [];
  const f = await fixture(t, { timeoutMs: 80, control: { cancel: () => new Promise(resolve => releases.push(resolve)) } });
  const results = await Promise.all(Array.from({ length: 16 }, () => f.send()));
  assert.ok(results.every(r => r.status === 503)); assert.equal(releases.length, 16);
  assert.equal((await f.send()).body.error.code, 'skillhub.publication_control_busy');
  for (const release of releases) release(observation(receipt(), true));
  await delay(10);
  const next = f.send();
  while (releases.length < 17) await delay(2);
  releases.at(-1)(observation(receipt(), true));
  assert.equal((await next).status, 200);
});

test('control HTTP has a shared authenticated service rate budget, not caller-supplied buckets', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 120; i++) assert.equal((await f.send(input('read'))).status, 200);
  assert.equal((await f.send()).status, 429);
  assert.equal(f.calls.length, 120);
});

test('production API registers a default-off control namespace before generic CORS and auth', async t => {
  const config = loadConfig({ publicationControlEnabled: false });
  const server = createApiServer(config, { store: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const result = await fetch(`http://127.0.0.1:${server.address().port}${PUBLICATION_CONTROL_PATH}`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } });
  assert.equal(result.status, 404); assert.equal(result.headers.get('access-control-allow-origin'), null);
});
