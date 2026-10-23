import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_DERIVATION_PATH } from '../../apps/api/publication-description-derivation.js';
import { proposalDigest } from '../../packages/publication-description-derivations/store.js';
import { loadConfig } from '../../packages/config/index.js';

const secret = 'pubderive_' + 'a'.repeat(64);
const input = {
  schemaVersion: 1,
  applicationId: 'pubdesc_' + 'b'.repeat(64),
  taskId: 'pubtask_12345678-1234-4123-8123-123456789abc',
  requestHash: 'c'.repeat(64),
  candidateHash: 'd'.repeat(64),
  proposal: { relativePath: 'SKILL.md', field: 'description', entryIndex: 0, text: 'A concise description.' }
};

test('description derivation route is default-off and does not touch storage', async () => {
  let touched = false;
  const handler = createPublicationDescriptionDerivationHandler(loadConfig({ publicationDescriptionDerivationEnabled: false }), {
    getPublicationDescriptionDerivation: async () => { touched = true; }
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${PUBLICATION_DESCRIPTION_DERIVATION_PATH}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 404);
    assert.equal(touched, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

const enabledConfig = () => loadConfig({
  publicationDescriptionDerivationEnabled: true,
  publicationDescriptionDerivationIssuer: 'https://cloud.example',
  publicationDescriptionDerivationAudience: 'https://cloud.example',
  publicationDescriptionDerivationPeerSecret: secret,
  publicationDescriptionDerivationTrustedProxyAddresses: ['127.0.0.1', '::ffff:127.0.0.1'],
  publicationTasksEnabled: true
});

async function withServer(config, store, fn) {
  const handler = createPublicationDescriptionDerivationHandler(config, store);
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const request = (port, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: PUBLICATION_DESCRIPTION_DERIVATION_PATH,
    method: 'POST', headers: { Host: 'cloud.example', 'X-Forwarded-Proto': 'https',
      Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  req.on('error', reject); req.end(JSON.stringify(body));
});

test('enabled description derivation rejects malformed and unauthorized peer requests before storage', async () => {
  let touched = false;
  const store = {
    getPublicationDescriptionDerivation: async () => { touched = true; },
    getPublicationDescriptionDerivationSource: async () => { touched = true; }
  };
  await withServer(enabledConfig(), store, async port => {
    const unauthorized = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: PUBLICATION_DESCRIPTION_DERIVATION_PATH,
        method: 'POST', headers: { Host: 'cloud.example', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json' } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(unauthorized.status, 401);
    const malformed = await request(port, { schemaVersion: 1 });
    assert.equal(malformed.status, 400);
  });
  assert.equal(touched, false);
});

test('same application replay returns the retained receipt without reading source again', async () => {
  let sourceTouched = false;
  const existing = {
    application_id: input.applicationId, task_id: input.taskId,
    request_hash: input.requestHash, candidate_hash: input.candidateHash,
    proposal_digest: proposalDigest(input.proposal),
    derived_bytes: 123, derived_request_hash: 'e'.repeat(64), derived_candidate_hash: 'f'.repeat(64),
    derivation_receipt: { schemaVersion: '1', replay: true }
  };
  const store = {
    getPublicationDescriptionDerivation: async () => existing,
    getPublicationDescriptionDerivationSource: async () => { sourceTouched = true; },
    retainPublicationDescriptionDerivation: async () => { throw new Error('must not retain on replay'); }
  };
  await withServer(enabledConfig(), store, async port => {
    const response = await request(port, input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      applicationId: input.applicationId, taskId: input.taskId, derivedBytes: 123,
      derivedRequestHash: 'e'.repeat(64), derivedCandidateHash: 'f'.repeat(64),
      receipt: { schemaVersion: '1', replay: true }, replayed: true
    });
  });
  assert.equal(sourceTouched, false);
});

test('same application with different source binding is a conflict', async () => {
  const store = {
    getPublicationDescriptionDerivation: async () => ({
      application_id: input.applicationId, task_id: input.taskId,
      request_hash: '0'.repeat(64), candidate_hash: input.candidateHash,
      proposal_digest: proposalDigest(input.proposal)
    })
  };
  await withServer(enabledConfig(), store, async port => {
    const response = await request(port, input);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'skillhub.publication_description_derivation_conflict');
  });
});

