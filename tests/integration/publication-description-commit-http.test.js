import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../../packages/config/index.js';
import { PublicationDescriptionCommitAdmissionError } from '../../packages/publication-description-derivations/commit-admission.js';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_COMMIT_PATH } from '../../apps/api/publication-description-derivation.js';

const secret = 'pubderive_' + 'a'.repeat(64);
const request = { schemaVersion: 1, applicationId: `pubdesc_${'b'.repeat(64)}`, permitId: `pubdescpermit_${'c'.repeat(32)}` };
const config = overrides => loadConfig({ publicationDescriptionDerivationEnabled: true,
  publicationDescriptionDerivationIssuer: 'https://cats.example',
  publicationDescriptionDerivationAudience: 'https://cloud.example',
  publicationDescriptionDerivationPeerSecret: secret,
  publicationDescriptionDerivationTrustedProxyAddresses: ['127.0.0.1'], ...overrides });

async function withServer(settings, store, run) {
  const handler = createPublicationDescriptionDerivationHandler(settings, store);
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function post(port, body, { auth = secret, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: PUBLICATION_DESCRIPTION_COMMIT_PATH, method: 'POST',
      headers: { Host: 'cloud.example', 'X-Forwarded-Proto': 'https', Authorization: `Bearer ${auth}`,
        'Content-Type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end(raw ?? JSON.stringify(body));
  });
}

test('derived commit admission endpoint is default-off and does not touch storage', async () => {
  let calls = 0;
  await withServer(config(), { admit: async () => { calls++; throw Error('must not run'); } }, async port => {
    assert.equal((await post(port, request)).status, 404);
  });
  assert.equal(calls, 0);
});

test('derived commit admission endpoint returns only the isolated queued completion', async () => {
  const seen = [];
  const store = { async admit(input) {
    seen.push(input);
    return { task_id: 'pubtask_12345678-1234-4123-8123-123456789abc', permit_id: input.permitId, state: 'queued', replayed: false };
  } };
  const active = config({ publicationDescriptionCommitAdmissionEnabled: true });
  await withServer(active, store, async port => {
    const first = await post(port, request);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { schemaVersion: 1, applicationId: request.applicationId,
      taskId: 'pubtask_12345678-1234-4123-8123-123456789abc', permitId: request.permitId, state: 'queued', replayed: false });
    assert.deepEqual(seen, [request]);
  });
});

test('derived commit admission endpoint fails closed for auth, schema and store errors', async () => {
  const active = config({ publicationDescriptionCommitAdmissionEnabled: true });
  await withServer(active, { admit: async () => { throw new PublicationDescriptionCommitAdmissionError('conflict'); } }, async port => {
    assert.equal((await post(port, request, { auth: 'wrong' })).status, 401);
    assert.equal((await post(port, { ...request, extra: true })).status, 400);
    const response = await post(port, request);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'skillhub.publication_description_derivation_conflict');
  });
});
