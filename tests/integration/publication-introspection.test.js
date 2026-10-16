import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { after, before, test } from 'node:test';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicationIntrospectionClient, createPublicationIntrospectionClientFromEnv, PublicationAuthorityError } from '../../packages/publication-delegation/introspection.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const secret = '1'.repeat(64), token = 'pubupload_' + '2'.repeat(64);
const audience = 'https://hub.example';
const raw = Buffer.from('{"source":{"type":"files","files":[{"path":"SKILL.md","content":"private source"}]}}');
const input = () => ({ token, entryRequestId: 'pubentry_' + '3'.repeat(32), authorityEpoch: 1,
  rawBody: Buffer.from(raw), sourceSnapshotHash: '4'.repeat(64), idempotencyKey: 'pubcandidate_' + '5'.repeat(32) });
const hash = b => createHash('sha256').update(b).digest('hex');
let tls;
before(async () => { tls = await publicationPeerTLS(); });
after(async () => { await tls?.close(); });

function reply(query, issuer) {
  const { schemaVersion, ...scope } = query;
  return { schemaVersion, active: true, grant: { ...scope, delegationId: 'pubgrant_' + '6'.repeat(32),
    issuer, audience, actorCatsCoUid: '9223372036854775806', botUid: '42', idempotencyKey: input().idempotencyKey,
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 119000).toISOString() } };
}

async function fixture(t, respond = (req, res, value) => res.end(JSON.stringify(value))) {
  const calls = [];
  let issuer;
  const server = https.createServer(tls, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const q = JSON.parse(body);
    calls.push({ method: req.method, url: req.url, headers: req.headers, q, body });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-store');
    respond(req, res, reply(q, issuer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  issuer = `https://127.0.0.1:${server.address().port}`;
  const config = { enabled: true, issuer, audience, peerSecret: secret };
  const transport = { requestImpl: (url, options, callback) => https.request(url, { ...options, ca: tls.cert }, callback) };
  return { config, transport, client: createPublicationIntrospectionClient(config, transport), calls, issuer };
}

async function fails(promise, kind = 'unavailable') {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof PublicationAuthorityError);
    assert.equal(error.code, `skillhub.publication_authority_${kind}`);
    assert.equal(error.status, kind === 'invalid' ? 400 : kind === 'inactive' ? 403 : 503);
    assert.equal(error.cause, undefined);
    for (const value of [secret, token, 'private source', 'upstream secret']) assert.ok(!inspect(error).includes(value));
    return true;
  });
}

test('peer client pins route and separate credentials, recomputes bytes and never caches observations', async t => {
  const f = await fixture(t);
  const request = input();
  const pending = f.client.checkUploadGrant(request);
  request.rawBody.fill(0); request.sourceSnapshotHash = 'f'.repeat(64); request.token = 'changed';
  const result = await pending;
  assert.ok(Object.isFrozen(result));
  assert.equal(Object.keys(result).length, 15);
  assert.equal(result.actorCatsCoUid, '9223372036854775806'); // no JS number rounding
  assert.equal(result.requestHash, hash(raw));
  assert.equal(result.requestBytes, raw.length);
  assert.equal(result.sourceSnapshotHash, input().sourceSnapshotHash);
  assert.equal(result.idempotencyKey, input().idempotencyKey);
  assert.ok(!JSON.stringify(result).includes(token));
  await f.client.checkUploadGrant(input());
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.equal(c.url, '/api/skillhub/publications/internal/upload-grants/introspect');
    assert.equal(c.method, 'POST');
    assert.equal(c.headers.authorization, `Bearer ${secret}`);
    assert.equal(c.headers['x-skillhub-upload-grant'], token);
    assert.equal(Number(c.headers['content-length']), Buffer.byteLength(c.body));
    assert.equal(c.headers['content-type'], 'application/json');
    assert.equal(c.headers['transfer-encoding'], undefined);
    assert.deepEqual(Object.keys(c.q).sort(), ['action', 'authorityEpoch', 'candidateRevision', 'entryRequestId', 'requestBytes', 'requestHash', 'schemaVersion', 'sourceSnapshotHash'].sort());
    assert.ok(!c.body.includes('private source'));
  }
});

test('peer client defaults off and malformed dedicated config cannot use a fallback', async () => {
  await fails(createPublicationIntrospectionClient().checkUploadGrant(input()), 'disabled');
  await fails(createPublicationIntrospectionClientFromEnv({}).checkUploadGrant(input()), 'disabled');
  const good = { enabled: true, issuer: 'https://cats.example', audience, peerSecret: secret };
  for (const issuer of ['http://cats.example', 'https://cats.example/', 'https://USER@cats.example',
    'https://Cats.example', 'https://cats.example?x=1', 'https://cats.example#x', 'https://cats.example:0',
    'https://cats.example:0443', 'https://cats.example:65536', 'https://cats..example', 'https://cats.example.',
    'https://127.1', 'https://[::1]', audience, audience + ':443']) {
    await fails(createPublicationIntrospectionClient({ ...good, issuer }).checkUploadGrant(input()), 'configuration');
  }
  for (const peerSecret of ['', 'jwt.a.b', 'A'.repeat(64), secret + '\n']) {
    await fails(createPublicationIntrospectionClient({ ...good, peerSecret }).checkUploadGrant(input()), 'configuration');
  }
  await fails(createPublicationIntrospectionClientFromEnv({ SKILLHUB_PUBLICATION_INTROSPECTION_ENABLED: 'true',
    CATSCO_API_KEY: secret, SKILLHUB_AGENT_CLIENT_SECRET: secret }).checkUploadGrant(input()), 'configuration');
});

test('peer client rejects caller identity, endpoints, bad tokens and invalid limits before network', async () => {
  let calls = 0;
  const client = createPublicationIntrospectionClient({ enabled: true, issuer: 'https://cats.example', audience, peerSecret: secret },
    { requestImpl: () => { calls++; throw new Error('should not call'); } });
  for (const change of [x => { x.actorCatsCoUid = '1'; }, x => { x.issuer = audience; }, x => { x.url = 'https://evil.example'; },
    x => { x.token = secret; }, x => { x.authorityEpoch = 9; }, x => { x.authorityEpoch = 1.5; },
    x => { x.entryRequestId = '../path'; }, x => { x.idempotencyKey = 'new-key'; }, x => { x.rawBody = ''; },
    x => { x.rawBody = Buffer.alloc(0); }, x => { x.rawBody = Buffer.alloc(75 * 1024 * 1024 + 1); },
    x => { x.rawBody = Buffer.from(new SharedArrayBuffer(8)); }, x => { x.sourceSnapshotHash = 'BAD'; },
    x => { x.sourceSnapshotHash = { toString: () => '4'.repeat(64) }; }, x => { delete x.token; }]) {
    const value = input(); change(value); await fails(client.checkUploadGrant(value), 'invalid');
  }
  assert.equal(calls, 0);
});

test('peer client distinguishes exact inactive response from invalid upstream envelopes', async t => {
  const f = await fixture(t, (req, res) => res.end('{"schemaVersion":1,"active":false}'));
  await fails(f.client.checkUploadGrant(input()), 'inactive');
  for (const rawReply of ['{"schemaVersion":1,"active":false,"grant":{}}', '{"schemaVersion":2,"active":false}',
    '{"schemaVersion":1,"active":"false"}', '{"schemaVersion":1,"active":null}',
    '{"schemaVersion":1,"active":false,"active":true}', '[]', '{}', 'null', '{"active":false}']) {
    await t.test(rawReply, async sub => {
      const bad = await fixture(sub, (req, res) => res.end(rawReply));
      await fails(bad.client.checkUploadGrant(input()));
    });
  }
});

test('peer client enforces the complete canonical binding and bounded recent observation', async t => {
  for (const [key, value] of [
    ['issuer', 'https://other.example'], ['audience', 'https://other.example'], ['action', 'publication.commit'],
    ['entryRequestId', 'pubentry_' + 'f'.repeat(32)], ['candidateRevision', 2], ['authorityEpoch', 2],
    ['requestHash', 'f'.repeat(64)], ['sourceSnapshotHash', 'f'.repeat(64)], ['requestBytes', raw.length + 1],
    ['idempotencyKey', 'pubcandidate_' + 'f'.repeat(32)], ['delegationId', '../private'], ['actorCatsCoUid', 7],
    ['actorCatsCoUid', '9223372036854775808'], ['actorCatsCoUid', '01'], ['actorCatsCoUid', '42'], ['botUid', '0'],
    ['botUid', null], ['expiresAt', new Date(Date.now() - 1000).toISOString()], ['expiresAt', new Date(Date.now() + 180000).toISOString()],
    ['observedAt', new Date(Date.now() - 10000).toISOString()], ['observedAt', new Date(Date.now() + 10000).toISOString()],
    ['observedAt', '2026-02-30T00:00:00Z'], ['expiresAt', 'not a date'], ['localPath', 'private source']
  ]) await t.test(`${key}=${value}`, async sub => {
    const f = await fixture(sub, (req, res, body) => { body.grant[key] = value; res.end(JSON.stringify(body)); });
    await fails(f.client.checkUploadGrant(input()));
  });
  await t.test('Go nanosecond timestamp', async sub => {
    const f = await fixture(sub, (req, res, body) => {
      body.grant.observedAt = body.grant.observedAt.replace('Z', '123456Z');
      body.grant.expiresAt = body.grant.expiresAt.replace('Z', '123456Z');
      res.end(JSON.stringify(body));
    });
    assert.ok(await f.client.checkUploadGrant(input()));
  });
});

test('peer transport rejects redirects, failures, bad encodings, duplicate keys and excessive responses', async t => {
  for (const mode of ['redirect', 'unauthorized', 'rate', 'error', 'content type', 'duplicate type', 'encoding',
    'cacheable', 'large declared', 'large streamed', 'large headers', 'truncated', 'bad utf8', 'duplicate json', 'deep json', 'extra json', 'missing field']) {
    await t.test(mode, async sub => {
      const f = await fixture(sub, (req, res, body) => {
        switch (mode) {
          case 'redirect': res.writeHead(307, { Location: '/redirect-target' }); return res.end();
          case 'unauthorized': res.statusCode = 401; return res.end('upstream secret');
          case 'rate': res.statusCode = 429; return res.end('upstream secret');
          case 'error': res.statusCode = 503; return res.end('upstream secret');
          case 'content type': res.setHeader('Content-Type', 'text/html'); break;
          case 'duplicate type': res.setHeader('Content-Type', ['application/json', 'application/json']); break;
          case 'encoding': res.setHeader('Content-Encoding', 'gzip'); break;
          case 'cacheable': res.setHeader('Cache-Control', 'public'); break;
          case 'large declared': res.setHeader('Content-Length', '9999'); res.flushHeaders(); return;
          case 'large streamed': res.write(' '.repeat(2048)); return res.end(' '.repeat(2049));
          case 'large headers': res.setHeader('X-Untrusted', 'x'.repeat(9000)); break;
          case 'truncated': res.setHeader('Content-Length', '4000'); res.write('{}'); res.flushHeaders(); setTimeout(() => res.destroy(), 10); return;
          case 'bad utf8': return res.end(Buffer.from([0xff]));
          case 'duplicate json': return res.end(JSON.stringify(body).replace('"active":true', '"active":false,"active":true'));
          case 'deep json': return res.end('['.repeat(10) + '0' + ']'.repeat(10));
          case 'extra json': return res.end(JSON.stringify(body) + '{}');
          case 'missing field': delete body.grant.observedAt; break;
        }
        res.end(JSON.stringify(body));
      });
      await fails(f.client.checkUploadGrant(input()));
      assert.equal(f.calls.length, 1, 'no redirect or retry');
    });
  }
});

test('native HTTPS rejects an untrusted certificate; arbitrary upstream errors stay redacted', async t => {
  const f = await fixture(t);
  await fails(createPublicationIntrospectionClient(f.config).checkUploadGrant(input()));
  assert.equal(f.calls.length, 0);
  const client = createPublicationIntrospectionClient(f.config, { requestImpl: () => {
    const error = new Error(`upstream secret ${secret} ${token}`); error.code = 'EXPOSE_ME'; throw error;
  } });
  await fails(client.checkUploadGrant(input()));
});

test('peer client bounds hanging headers and response bodies without retries', async t => {
  for (const mode of ['headers', 'body']) await t.test(mode, { timeout: 9000 }, async sub => {
    const f = await fixture(sub, (req, res) => { if (mode === 'body') { res.write('{'); res.flushHeaders(); } });
    const start = performance.now();
    await fails(f.client.checkUploadGrant(input()));
    assert.ok(performance.now() - start < 8500);
    assert.equal(f.calls.length, 1);
  });
});

test('caller cancellation and concurrency admission release slots only after network closes', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, (req, res, body) => { held.then(() => res.end(JSON.stringify(body))); });
  const abort = new AbortController(); abort.abort();
  await fails(f.client.checkUploadGrant(input(), { signal: abort.signal }));
  assert.equal(f.calls.length, 0);
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const work = controllers.map(c => fails(f.client.checkUploadGrant(input(), { signal: c.signal })));
  for (let i = 0; i < 200 && f.calls.length < 16; i++) await delay(10);
  assert.equal(f.calls.length, 16);
  await fails(f.client.checkUploadGrant(input()), 'busy');
  for (const c of controllers) c.abort(new Error('upstream secret'));
  await Promise.all(work);
  release();
  assert.ok(await f.client.checkUploadGrant(input()));
  assert.equal(f.calls.length, 17);
});
