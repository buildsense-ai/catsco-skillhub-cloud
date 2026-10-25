import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../../packages/config/index.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { delegatedFixture } from '../helpers/delegated-publication.js';
import { descriptionCopyFixture } from '../helpers/description-copy.js';
import { derivePublicationDescription } from '../../packages/publication-tasks/description-derivation.js';
import { createPublicationDescriptionReleasePlanner, validDescriptionReleasePlanRequest } from '../../packages/publication-description-derivations/release-plan.js';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_PLAN_PATH } from '../../apps/api/publication-description-derivation.js';

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL, pgOnly = { skip: !databaseUrl };
const issuer = 'https://commit.invalid', audience = 'https://cloud.invalid';
const code = kind => ({ code: 'skillhub.publication_description_derivation_' + kind });
const secret = 'pubderive_' + 'a'.repeat(64);

async function fixture(t) {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const schema = 'description_plan_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => { await closePools(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  await admin.query(`SET search_path TO "${schema}"`);
  const folder = new URL('../../infra/migrations/', import.meta.url);
  for (const name of (await fs.readdir(folder)).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    await admin.query(await fs.readFile(new URL(name, folder), 'utf8'));
  }
  const url = new URL(databaseUrl); url.searchParams.set('options', '-c search_path=' + schema);
  const config = loadConfig({ databaseUrl: url.href, nodeEnv: 'test', publicationTasksEnabled: true, publicationPublishingEnabled: true });
  const store = createStore(config), copy = descriptionCopyFixture();
  const f = await delegatedFixture(store, config, { rawBody: Buffer.from(copy.original.rawJson) });
  // Intake generates its own durable report identity. Derive from THAT exact
  // report, not the independently generated report in descriptionCopyFixture.
  const source = await store.getPublicationDescriptionDerivationSource(f.receipt.taskId);
  const report = source.validation_result ?? source.intake_result;
  const derived = derivePublicationDescription({ rawJson: copy.original.rawJson, requestHash: f.receipt.requestHash,
    candidateHash: f.receipt.sourceSnapshotHash, validation: report.body.validation ?? report.body.error.validation,
    proposal: copy.request.proposal });
  assert.equal(derived.status, 200);
  const request = { ...copy.request, taskId: f.receipt.taskId, expectedReceipt: derived.derived.receipt,
    derivedBytes: Buffer.byteLength(derived.derived.rawJson) };
  await store.retainPublicationDescriptionDerivation({ applicationId: request.applicationId,
    taskId: request.taskId, proposal: request.proposal, derived: derived.derived });
  const input = { copy: request, publicationReceipt: f.receipt, confirmVersionPublish: false };
  const planner = extra => createPublicationDescriptionReleasePlanner({ enabled: true, config, store, issuer, audience, ...extra });
  const count = async table => Number((await store.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  return { config, store, f, input, planner, count };
}

test('description release planner is default-off and rejects malformed/cross-candidate references', async () => {
  for (const enabled of [undefined, false, 'true']) {
    await assert.rejects(createPublicationDescriptionReleasePlanner({ enabled }).plan({}), code('disabled'));
  }
  assert.throws(() => createPublicationDescriptionReleasePlanner({ enabled: true }), code('configuration'));
  const f = descriptionCopyFixture();
  assert.equal(validDescriptionReleasePlanRequest({ copy: f.request, publicationReceipt: {}, confirmVersionPublish: false }), false);
  const publicationReceipt = { schemaVersion: 1, entryRequestId: 'pubentry_' + 'a'.repeat(32),
    candidateRevision: 1, acceptanceEpoch: 1, requestHash: f.request.requestHash,
    sourceSnapshotHash: f.request.candidateHash, requestBytes: Buffer.byteLength(f.original.rawJson),
    delegationId: 'pubgrant_' + 'b'.repeat(32), idempotencyKey: 'pubcandidate_' + 'c'.repeat(32),
    taskId: f.request.taskId, eventId: 'pubevent_' + randomUUID() };
  const valid = { copy: f.request, publicationReceipt, confirmVersionPublish: false };
  assert.equal(validDescriptionReleasePlanRequest(valid), true);
  for (const changed of [{ taskId: 'pubtask_' + randomUUID() }, { requestHash: 'e'.repeat(64) },
    { sourceSnapshotHash: f.request.expectedReceipt.derivedCandidateHash }]) {
    assert.equal(validDescriptionReleasePlanRequest({ ...valid, publicationReceipt: { ...publicationReceipt, ...changed } }), false);
  }
  assert.equal(validDescriptionReleasePlanRequest({ ...valid, extra: true }), false);
  for (const input of [null, {}, [], { copy: f.request, publicationReceipt: {}, confirmVersionPublish: 'true' }]) {
    assert.equal(Boolean(validDescriptionReleasePlanRequest(input)), false);
  }
});

test('PostgreSQL derived plan uses real retained bytes, reserves one version across concurrent retries and survives reconstruction', pgOnly, async t => {
  const { store, f, input, planner, count } = await fixture(t);
  const before = structuredClone(input);
  const [a, b] = await Promise.all([planner().plan(input), planner().plan(input)]);
  assert.deepEqual(a, b); assert.deepEqual(input, before);
  assert.deepEqual(await planner().plan(input), a);
  assert.equal(a.target.candidateHash, input.copy.expectedReceipt.derivedCandidateHash);
  assert.notEqual(a.target.candidateHash, f.receipt.sourceSnapshotHash);
  assert.deepEqual(a.publicationReceipt, f.receipt);
  assert.deepEqual(a.receipt, input.copy.expectedReceipt);
  assert.equal(a.derivedBytes, input.copy.derivedBytes);
  assert.equal(a.target.version, '1.0.0');
  for (const privateKey of ['manifest', 'identity', 'proposal', 'bytes', 'rawJson']) assert.equal(privateKey in a, false);
  assert.equal(JSON.stringify(a).includes('PRIVATE'), false);
  assert.equal(await count('publication_description_release_plans'), 1);
  assert.equal(await count('publication_version_reservations'), 1);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('publication_delegated_plans'), 0);
  const original = (await store.query('SELECT candidate,state,attempts,commit_bytes FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0];
  assert.deepEqual(original.candidate, f.input.rawBody); assert.equal(original.state, 'delegated_pending'); assert.equal(original.attempts, 0);
  assert.ok(Number(original.commit_bytes) > 0);
  await assert.rejects(planner().plan({ ...input, confirmVersionPublish: true }), code('conflict'));
  await assert.rejects(planner().plan({ ...input, copy: { ...input.copy, expectedReceipt: { ...input.copy.expectedReceipt, validationDigest: 'f'.repeat(64) } } }), code('conflict'));
  for (const sql of ['UPDATE publication_description_release_plans SET target=target', 'DELETE FROM publication_description_release_plans']) {
    await assert.rejects(store.query(sql + ' WHERE application_id=$1', [input.copy.applicationId]), { code: '23514' });
  }
  const saved = (await store.query('SELECT * FROM publication_description_release_plans WHERE application_id=$1', [input.copy.applicationId])).rows[0];
  await assert.rejects(store.query('INSERT INTO publication_delegated_plans(task_id,receipt,target,manifest,identity) VALUES($1,$2,$3,$4,$5)',
    [f.receipt.taskId, saved.receipt, saved.target, saved.manifest, saved.identity]), { code: '23514' });
});

test('PostgreSQL source cancellation and publisher change during verification cannot reserve a release', pgOnly, async t => {
  for (const change of ['cancel', 'publisher']) {
    await t.test(change, async t => {
      const { store, f, input, planner, count } = await fixture(t);
      let reads = 0;
      const wrapped = { ...store, async getPublicationDescriptionDerivationSource(id) {
        const row = await store.getPublicationDescriptionDerivationSource(id);
        if (++reads === 2) {
          if (change === 'cancel') await store.query("UPDATE publication_tasks SET state='cancelled',delegated_cancelled_at=now(),candidate=NULL,candidate_bytes=0 WHERE id=$1", [f.receipt.taskId]);
          else await store.query("UPDATE publisher_profiles SET status='suspended' WHERE id=$1", [f.profile.id]);
        }
        return row;
      } };
      await assert.rejects(planner({ store: wrapped }).plan(input), code(change === 'cancel' ? 'source_unavailable' : 'publisher_changed'));
      assert.equal(await count('publication_description_release_plans'), 0);
      assert.equal(await count('publication_version_reservations'), 0);
    });
  }
});

test('PostgreSQL storage and version-confirmation failures roll back plans and reservations', pgOnly, async t => {
  const { config, store, f, input, planner, count } = await fixture(t);
  const small = { ...config, publicationTasks: { ...config.publicationTasks, maxStoredBytes: 1 } };
  await assert.rejects(planner({ config: small }).plan(input), code('storage_limit'));
  assert.equal(await count('publication_description_release_plans'), 0);
  assert.equal(await count('publication_version_reservations'), 0);
  const skillId = f.profile.namespace + '/recovery-fixture';
  await store.reservePublicVersion({ uploadId: 'occupied-upload', skillId, ownerId: f.owner, version: '1.0.0' });
  await assert.rejects(planner().plan(input), code('version_confirmation_required'));
  assert.equal(await count('publication_description_release_plans'), 0);
  assert.equal(await count('publication_version_reservations'), 1);
  const accepted = await planner().plan({ ...input, confirmVersionPublish: true });
  assert.equal(accepted.target.version, '1.0.1');
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [f.receipt.taskId]);
  await assert.rejects(planner().plan({ ...input, confirmVersionPublish: true }), code('source_unavailable'));
});

async function httpPlan(config, store, input, { drop = false, auth = secret } = {}) {
  const handler = createPublicationDescriptionDerivationHandler(config, store);
  const server = http.createServer((req, res) => { if (drop) res.end = () => res.destroy(); void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: PUBLICATION_DESCRIPTION_PLAN_PATH, method: 'POST',
        headers: { Host: 'cloud.invalid', 'X-Forwarded-Proto': 'https', Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' } }, res => {
        const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', reject); req.end(JSON.stringify(input));
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('PostgreSQL HTTP planning is separately gated and committed-response loss recovers one exact target', pgOnly, async t => {
  const { config, store, input, count } = await fixture(t);
  const base = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation,
    enabled: true, planEnabled: false, issuer, audience, peerSecret: secret, trustedProxyAddresses: ['127.0.0.1'] } };
  assert.equal((await httpPlan(base, store, input)).status, 404);
  const active = { ...base, publicationDescriptionDerivation: { ...base.publicationDescriptionDerivation, planEnabled: true } };
  assert.equal((await httpPlan(active, store, input, { auth: 'wrong' })).status, 401);
  assert.equal(await count('publication_description_release_plans'), 0);
  await assert.rejects(httpPlan(active, store, input, { drop: true }), { code: 'ECONNRESET' });
  assert.equal(await count('publication_description_release_plans'), 1);
  const first = await httpPlan(active, store, input), replay = await httpPlan(active, store, input);
  assert.equal(first.status, 200); assert.deepEqual(first, replay);
  assert.equal(await count('publication_version_reservations'), 1);
  assert.equal(await count('publication_commits'), 0);
});
