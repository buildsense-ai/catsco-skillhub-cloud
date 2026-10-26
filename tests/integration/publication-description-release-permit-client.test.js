import assert from 'node:assert/strict';
import https from 'node:https';
import { before, after, test } from 'node:test';
import { inspect } from 'node:util';
import { createPublicationDescriptionReleasePermitClient, PublicationDescriptionReleasePermitError,
  DESCRIPTION_RELEASE_PERMIT_PATH } from '../../packages/publication-description-derivations/release-permit-client.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const secret = '1'.repeat(64), audience = 'https://cloud.example';
const request = () => ({ schemaVersion: 1, entryId: 'pubentry_' + 'a'.repeat(32), applicationId: 'pubdesc_' + 'b'.repeat(64),
  target: { candidateHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), publisherUserId: 'usr_test', publisherProfileId: 'profile_test',
    namespace: 'author', skillId: 'author/test', version: '1.0.1', uploadId: 'upl_test', releaseAt: '2026-10-19T00:00:00.000Z', confirmVersionPublish: false } });
const permit = input => ({ schemaVersion: 1, entryId: input.entryId, applicationId: input.applicationId, target: { ...input.target },
  intentHash: 'e'.repeat(64), permitId: 'pubdescpermit_' + 'f'.repeat(32), authorizedAt: '2026-10-19T00:00:01.123456Z' });
let tls;
before(async () => { tls = await publicationPeerTLS(); });
after(async () => { await tls?.close(); });

async function fixture(t, respond = (_req, res, q) => res.end(JSON.stringify(permit(q)))) {
  const calls = [];
  const server = https.createServer(tls, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), q = JSON.parse(body);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body, q });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, no-store');
    respond(req, res, q);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { enabled: true, issuer: `https://127.0.0.1:${server.address().port}`, audience, peerSecret: secret };
  const transport = { requestImpl: (url, options, callback) => https.request(url, { ...options, ca: tls.cert }, callback) };
  return { config, transport, client: createPublicationDescriptionReleasePermitClient(config, transport), calls };
}

async function fails(promise, kind = 'unavailable') {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof PublicationDescriptionReleasePermitError);
    assert.equal(error.code, `skillhub.publication_description_release_permit_${kind}`);
    assert.equal(error.cause, undefined);
    for (const value of [secret, 'upstream secret', 'pubupload_']) assert.ok(!inspect(error).includes(value));
    return true;
  });
}

test('description permit client sends only exact frozen facts and preserves timestamp precision', async t => {
  const f = await fixture(t), q = request(), pending = f.client.authorize(q);
  q.target.version = '9.9.9'; q.entryId = 'changed';
  const result = await pending;
  assert.deepEqual(result, permit(request()));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.target));
  for (const call of f.calls) {
    assert.equal(call.url, DESCRIPTION_RELEASE_PERMIT_PATH); assert.equal(call.method, 'POST');
    assert.deepEqual(call.q, request()); assert.equal(call.headers.authorization, `Bearer ${secret}`);
    assert.equal(call.headers['content-length'], String(Buffer.byteLength(call.body)));
    for (const header of ['cookie', 'origin', 'x-skillhub-upload-grant']) assert.equal(call.headers[header], undefined);
    assert.ok(!call.body.includes(secret));
  }
});

test('description permit is default-off and rejects invalid config or request before network', async t => {
  await fails(createPublicationDescriptionReleasePermitClient().authorize(request()), 'disabled');
  const good = { enabled: true, issuer: 'https://cats.example', audience, peerSecret: secret };
  for (const patch of [{ issuer: 'http://cats.example' }, { issuer: audience }, { audience: 'https://user@cloud.example' },
    { peerSecret: secret + '\n' }, { peerSecret: 'A'.repeat(64) }]) {
    await fails(createPublicationDescriptionReleasePermitClient({ ...good, ...patch }).authorize(request()), 'configuration');
  }
  let calls = 0;
  const client = createPublicationDescriptionReleasePermitClient(good, { requestImpl: () => { calls++; throw Error('upstream secret'); } });
  for (const bad of [null, {}, { ...request(), extra: true }, { ...request(), applicationId: 'wrong' },
    { ...request(), entryId: 'pubentry_' + 'A'.repeat(32) }, { ...request(), target: { ...request().target, version: '1.0.0\n' } }]) {
    await fails(client.authorize(bad), 'invalid');
  }
  assert.equal(calls, 0);
});

test('only exact upstream denial statuses map to terminal outcomes', async t => {
  for (const [status, code, kind] of [[403, 'commit_denied', 'denied'], [409, 'commit_cancelled', 'cancelled'],
    [409, 'commit_conflict', 'conflict'], [403, 'secure_transport_required', 'unavailable'], [503, 'commit_conflict', 'unavailable']]) {
    await t.test(`${status}/${code}`, async sub => {
      const f = await fixture(sub, (_req, res) => { res.statusCode = status; res.end(JSON.stringify({ error: { code: `publication.${code}`, message: 'upstream secret' } })); });
      await fails(f.client.authorize(request()), kind);
    });
  }
});

test('permit response must exactly bind entry, application and full target', async t => {
  for (const change of [
    value => { value.extra = true; }, value => { value.permitId += 'x'; }, value => { value.intentHash = 'BAD'; },
    value => { value.authorizedAt = '2026-02-31T00:00:00.000Z'; }, value => { value.authorizedAt += 'x'; },
    value => { value.entryId = 'pubentry_' + '0'.repeat(32); }, value => { value.applicationId = 'pubdesc_' + '0'.repeat(64); },
    value => { value.target.version = '2.0.0'; }, value => { value.target.extra = true; }, value => { delete value.target; }
  ]) {
    const f = await fixture(t, (_req, res, q) => { const reply = permit(q); change(reply); res.end(JSON.stringify(reply)); });
    await fails(f.client.authorize(request()));
  }
});
