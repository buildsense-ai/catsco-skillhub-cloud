import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_DERIVATION_PATH } from '../../apps/api/publication-description-derivation.js';
import { loadConfig } from '../../packages/config/index.js';

const secret = 'a'.repeat(64);
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

