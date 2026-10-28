import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../../packages/config/index.js';
import { createPublicationDescriptionReleaseStatusReader, validDescriptionReleaseStatusRequest } from '../../packages/publication-description-derivations/release-status.js';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_RELEASE_STATUS_PATH } from '../../apps/api/publication-description-derivation.js';
import { descriptionReleaseStatusFixture } from '../helpers/description-release-status.js';

const issuer = 'https://cats.example', audience = 'https://cloud.example', secret = 'pubderive_' + 'a'.repeat(64);
const reader = store => createPublicationDescriptionReleaseStatusReader({ enabled: true, store, issuer, audience });
const code = kind => ({ code: 'skillhub.publication_description_derivation_' + kind });

test('release status is default-off and rejects malformed references before storage', async () => {
  const f = descriptionReleaseStatusFixture();
  assert.equal(validDescriptionReleaseStatusRequest(f.request), true);
  await assert.rejects(createPublicationDescriptionReleaseStatusReader({ store: f.store }).read(f.request), code('disabled'));
  for (const request of [null, {}, { ...f.request, extra: true }, { ...f.request, publicationReceipt: {} },
    { ...f.request, permitId: 'pubpermit_' + 'b'.repeat(32) }, { ...f.request, applicationId: '../private' }]) {
    await assert.rejects(reader(f.store).read(request), code('invalid'));
  }
  assert.deepEqual(f.queries, []);
});

test('release status exposes a whitelisted result only for a matching registered package', async () => {
  const f = descriptionReleaseStatusFixture();
  f.publish();
  const result = await reader(f.store).read(f.request);
  assert.equal(result.state, 'published');
  assert.deepEqual(Object.keys(result.result), ['skillId', 'version', 'packageId', 'checksumSha256', 'publishedAt']);
  assert.equal(JSON.stringify(result).includes('/private/'), false);
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.publicationReceipt, f.request.publicationReceipt);
  f.row.target.version = '2.0.0';
  assert.equal(result.target.version, '1.0.0');
});

test('release status rejects mismatched target, proof, package and result-state bindings', async t => {
  const mutations = {
    application: f => { f.row.application_id = 'pubdesc_' + 'f'.repeat(64); },
    task: f => { f.row.task_id = 'other'; },
    permit: f => { f.row.permit_id = 'other'; },
    state: f => { f.row.state = 'unknown'; },
    candidate: f => { f.row.derived_candidate_hash = f.request.publicationReceipt.sourceSnapshotHash; },
    receipt: f => { f.row.plan_receipt.acceptanceEpoch++; },
    target: f => { f.row.plan_target.version = '2.0.0'; },
    proof: f => { f.row.proof.permitId = 'pubdescpermit_' + 'f'.repeat(32); },
    result: f => { f.row.publication_result.version = '2.0.0'; },
    package: f => { f.row.package_id = null; },
    checksum: f => { f.row.package_checksum = 'f'.repeat(64); },
    upload: f => { f.row.package_upload_id = 'other'; },
    owner: f => { f.row.package_owner_id = 'other'; },
    timestamp: f => { f.row.package_published_at = 'invalid'; },
    error: f => { f.row.error_code = 'unexpected'; },
    earlyResult: f => { f.row.state = 'committing'; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = descriptionReleaseStatusFixture(); f.publish(); mutate(f);
    await assert.rejects(reader(f.store).read(f.request), code('conflict'));
  });
});

test('release status normalizes failure codes and suppresses transient/internal errors', async () => {
  const f = descriptionReleaseStatusFixture();
  for (const state of ['queued', 'publishing', 'committing', 'publish_failed']) {
    f.row.state = state; f.row.error_code = '/root/private TOKEN';
    const result = await reader(f.store).read(f.request);
    assert.equal(result.result, null);
    assert.equal(result.errorCode, state === 'publish_failed' ? 'skillhub.publication_description_release_commit_unavailable' : null);
  }
  for (const stored of ['copy_changed', 'skillhub.publication_description_release_commit_copy_changed']) {
    f.row.error_code = stored;
    assert.equal((await reader(f.store).read(f.request)).errorCode, 'skillhub.publication_description_release_commit_copy_changed');
  }
  await assert.rejects(reader({ tx: async () => { throw Error('/private DB password'); } }).read(f.request),
    error => error.code.endsWith('_unavailable') && !error.message.includes('/private'));
});

async function withServer(overrides, store, run) {
  const config = loadConfig({ publicationDescriptionDerivationEnabled: true, publicationDescriptionDerivationIssuer: issuer,
    publicationDescriptionDerivationAudience: audience, publicationDescriptionDerivationPeerSecret: secret,
    publicationDescriptionDerivationTrustedProxyAddresses: ['127.0.0.1'], ...overrides });
  const handler = createPublicationDescriptionDerivationHandler(config, store);
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function post(port, input, { auth = secret, headers = {}, raw, path = PUBLICATION_DESCRIPTION_RELEASE_STATUS_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { Host: 'cloud.example',
      'X-Forwarded-Proto': 'https', Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(raw ?? JSON.stringify(input));
  });
}

test('release status HTTP has independent default-off gates and no admission side effect', async () => {
  const f = descriptionReleaseStatusFixture();
  await withServer({}, f.store, async port => assert.equal((await post(port, f.request)).status, 404));
  await withServer({ publicationDescriptionDerivationEnabled: false, publicationDescriptionReleaseStatusEnabled: true }, f.store,
    async port => assert.equal((await post(port, f.request)).status, 404));
  assert.deepEqual(f.queries, []);
  f.store.admit = () => { throw Error('must never admit'); };
  await withServer({ publicationDescriptionReleaseStatusEnabled: true }, f.store, async port => {
    const response = await post(port, f.request);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.state, 'queued');
    assert.equal(response.body.result, null);
    assert.deepEqual(response.body.publicationReceipt, f.request.publicationReceipt);
    for (const options of [{ auth: 'wrong' }, { headers: { Cookie: 'session=browser' } }, { headers: { Origin: issuer } }]) {
      assert.equal((await post(port, f.request, options)).status, 401);
    }
    assert.equal((await post(port, f.request, { path: PUBLICATION_DESCRIPTION_RELEASE_STATUS_PATH + '?extra=true' })).status, 404);
    assert.equal((await post(port, f.request, { raw: '{"schemaVersion":1,"schemaVersion":1}' })).status, 400);
    assert.equal((await post(port, { ...f.request, publicationReceipt: {} })).status, 400);
  });
});
