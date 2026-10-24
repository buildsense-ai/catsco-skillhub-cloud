import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { loadConfig } from '../../packages/config/index.js';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_READ_PATH } from '../../apps/api/publication-description-derivation.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';
import { descriptionCopyFixture } from '../helpers/description-copy.js';

const secret = 'pubderive_' + 'a'.repeat(64);
const config = overrides => loadConfig({ publicationDescriptionDerivationEnabled: true,
  publicationDescriptionReadEnabled: true, publicationDescriptionDerivationIssuer: 'https://cats.example',
  publicationDescriptionDerivationAudience: 'https://cloud.example', publicationDescriptionDerivationPeerSecret: secret,
  publicationDescriptionDerivationTrustedProxyAddresses: ['127.0.0.1'], publicationTasksEnabled: true, ...overrides });
async function withServer(settings, store, run, tls = null) {
  const handler = createPublicationDescriptionDerivationHandler(settings, store);
  const serve = (req, res) => void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  const server = tls ? https.createServer(tls, serve) : http.createServer(serve);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function request(port, input, { headers = {}, path = PUBLICATION_DESCRIPTION_READ_PATH, method = 'POST', raw, tls } = {}) {
  return new Promise((resolve, reject) => {
    const req = (tls ? https : http).request({ host: '127.0.0.1', port, path, method,
      ...(tls ? { ca: tls.cert } : {}), headers: Object.fromEntries(Object.entries({ Host: 'cloud.example', 'X-Forwarded-Proto': 'https',
        Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers }).filter(([, value]) => value !== undefined)) }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(raw ?? JSON.stringify(input));
  });
}

test('copy read has its own default-off gate in addition to derivation gate', async () => {
  for (const overrides of [{ publicationDescriptionReadEnabled: false }, { publicationDescriptionDerivationEnabled: false }]) {
    await withServer(config(overrides), { getPublicationDescriptionDerivation() { throw Error('storage must not run'); } }, async port => {
      assert.equal((await request(port, {})).status, 404);
    });
  }
});

test('HTTP recovery binds exact receipt, returns private octets and survives handler recreation', async () => {
  const f = descriptionCopyFixture();
  const store = { async getPublicationDescriptionDerivation() { return f.row; },
    async getPublicationDescriptionDerivationSource() { return f.source; } };
  for (let i = 0; i < 2; i++) await withServer(config(), store, async port => {
    // The first valid response may be lost by the caller; a new handler still
    // recovers the same retained bytes without INSERT/re-retention or publish.
    const response = await request(port, f.request);
    assert.equal(response.status, 200, response.bytes.toString());
    assert.deepEqual(response.bytes, f.row.derived_raw_json);
    assert.equal(Number(response.headers['content-length']), f.request.derivedBytes);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});

test('real HTTPS peer recovery verifies TLS without trusting proxy headers', async () => {
  const tls = await publicationPeerTLS(), f = descriptionCopyFixture();
  try {
    await withServer(config({ publicationDescriptionDerivationTrustedProxyAddresses: [],
      publicationDescriptionDerivationAudience: 'https://localhost' }), {
      async getPublicationDescriptionDerivation() { return f.row; },
      async getPublicationDescriptionDerivationSource() { return f.source; }
    }, async port => {
      const response = await request(port, f.request, { tls, headers: { Host: 'localhost', 'X-Forwarded-Proto': undefined } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, f.row.derived_raw_json);
    }, tls);
  } finally { await tls.close(); }
});

test('read route rejects browser/auth/transport/schema failures before accessing storage', async () => {
  const f = descriptionCopyFixture(); let touched = 0;
  await withServer(config(), { getPublicationDescriptionDerivation() { touched++; throw Error('private details'); } }, async port => {
    for (const headers of [{ Authorization: 'Bearer bad' }, { Origin: 'https://cats.example' },
      { Cookie: 'session=browser' }, { Host: 'wrong.example' }, { 'X-Forwarded-Proto': 'http' }]) {
      const response = await request(port, f.request, { headers });
      assert.equal(response.status, 401);
      assert.equal(response.bytes.includes('PRIVATE'), false);
    }
    for (const raw of ['{', JSON.stringify({ ...f.request, extra: true }),
      '{"schemaVersion":1,"schemaVersion":1}', ' '.repeat(32769)]) {
      assert.equal((await request(port, null, { raw })).status, 400);
    }
    assert.equal((await request(port, f.request, { path: PUBLICATION_DESCRIPTION_READ_PATH + '?candidate=forged' })).status, 404);
    assert.equal((await request(port, f.request, { method: 'GET' })).status, 405);
  });
  assert.equal(touched, 0);
});

test('storage errors and receipt mismatch never disclose candidate bytes', async () => {
  const f = descriptionCopyFixture();
  for (const [store, status] of [
    [{ async getPublicationDescriptionDerivation() { throw Error('PRIVATE SQL credentials'); } }, 503],
    [{ async getPublicationDescriptionDerivation() { return { ...f.row, request_hash: '0'.repeat(64) }; } }, 409]
  ]) await withServer(config(), store, async port => {
    const response = await request(port, f.request);
    assert.equal(response.status, status);
    assert.equal(response.bytes.includes('PRIVATE'), false);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  });
});

test('timed-out SQL retains concurrency slots until actual work settles', async () => {
  const f = descriptionCopyFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withServer(config({ publicationDescriptionDerivationTimeoutMs: 1000 }), {
    async getPublicationDescriptionDerivation() { await gate; return f.row; },
    async getPublicationDescriptionDerivationSource() { return f.source; }
  }, async port => {
    const responses = await Promise.all([request(port, f.request), request(port, f.request)]);
    assert.deepEqual(responses.map(r => r.status), [503, 503]);
    const busy = await request(port, f.request);
    assert.equal(JSON.parse(busy.bytes).error.code, 'skillhub.publication_description_derivation_busy');
    release();
    await nextTurn();
    assert.equal((await request(port, f.request)).status, 200);
  });
});

test('invalid configured origins fail closed before storage', async () => {
  for (const value of ['http://cloud.example', 'https://user@cloud.example', 'https://cloud.example/path', 'not-a-url']) {
    await withServer(config({ publicationDescriptionDerivationAudience: value }), {
      getPublicationDescriptionDerivation() { throw Error('must not access storage'); }
    }, async port => { assert.equal((await request(port, {})).status, 503); });
  }
});
