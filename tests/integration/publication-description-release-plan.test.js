import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../../packages/config/index.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { delegatedFixture } from '../helpers/delegated-publication.js';
import { descriptionCopyFixture } from '../helpers/description-copy.js';
import { derivePublicationDescription } from '../../packages/publication-tasks/description-derivation.js';
import { createPublicationDescriptionReleasePlanner, validDescriptionReleasePlanRequest } from '../../packages/publication-description-derivations/release-plan.js';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_PLAN_PATH,
  PUBLICATION_DESCRIPTION_AUTHORIZE_PATH } from '../../apps/api/publication-description-derivation.js';
import { createDelegatedPublicationControlStore } from '../../packages/publication-delegation/control-store.js';
import { PublicationDescriptionReleasePermitError } from '../../packages/publication-description-derivations/release-permit-client.js';
import { createPublicationDescriptionCommitAdmission } from '../../packages/publication-description-derivations/commit-admission.js';
import { createPublicationDescriptionReleaseWorker } from '../../packages/publication-description-derivations/worker.js';
import { createPublicationDescriptionReleaseCommitWorker } from '../../packages/publication-description-derivations/commit-worker.js';
import { createPublicationDescriptionReleaseCommitStore } from '../../packages/publication-description-derivations/commit-store.js';
import { canonicalJson } from '../../packages/signing/index.js';

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL, pgOnly = { skip: !databaseUrl };
const issuer = 'https://commit.invalid', audience = 'https://cloud.invalid';
const code = kind => ({ code: 'skillhub.publication_description_derivation_' + kind });
const secret = 'pubderive_' + 'a'.repeat(64);

function permitFor(request) {
  return { schemaVersion: 1, entryId: request.entryId, applicationId: request.applicationId, target: structuredClone(request.target),
    intentHash: 'a'.repeat(64), permitId: 'pubdescpermit_' + 'b'.repeat(32), authorizedAt: '2026-10-26T06:00:00.123456Z' };
}

async function fixture(t, { beforeAdmissionMigration = false } = {}) {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const schema = 'description_plan_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => { await closePools(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  await admin.query(`SET search_path TO "${schema}"`);
  const folder = new URL('../../infra/migrations/', import.meta.url);
  for (const name of (await fs.readdir(folder)).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    if (beforeAdmissionMigration && (name.startsWith('023_') || name.startsWith('024_') || name.startsWith('025_'))) continue;
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

async function workerFixture(t) {
  const fixtureResult = await fixture(t);
  const { config, store, input, planner } = fixtureResult;
  const plan = await planner().plan(input);
  const permitClient = { async authorize(request) { return permitFor(request); } };
  const activeConfig = { ...config, publicationDescriptionDerivation: {
    ...config.publicationDescriptionDerivation, planEnabled: true } };
  const authorized = await planner({ config: activeConfig, releasePermitEnabled: true, permitClient }).authorize({
    schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt });
  const admitted = await createPublicationDescriptionCommitAdmission({ enabled: true, store }).admit({
    schemaVersion: 1, applicationId: plan.applicationId, permitId: authorized.permit.permitId });
  assert.equal(admitted.state, 'queued');
  const worker = (extra = {}) => createPublicationDescriptionReleaseWorker({ enabled: true, config, store, ...extra });
  const row = async () => (await store.query('SELECT * FROM publication_description_release_commits WHERE application_id=$1',
    [plan.applicationId])).rows[0];
  return { ...fixtureResult, plan, admitted, worker, row };
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

// Keep Git, scanning, and package storage deterministic while exercising the
// completion worker against the real PostgreSQL lease and commit protocol.
async function completionFixture(t, { releaseStore: releaseStoreOverride, holdPreparation = false } = {}) {
  const prepared = await workerFixture(t);
  const preparedRow = await prepared.worker().once();
  assert.equal(preparedRow.state, 'committing');
  const task = await prepared.row();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillhub-derived-completion-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const tempConfig = loadConfig({
    ...prepared.config,
    root: tempRoot,
    storageRoot: path.join(tempRoot, 'storage'),
    sharedRoot: path.join(tempRoot, 'shared'),
    nodeEnv: 'test',
    publicationTasksEnabled: true,
    publicationPublishingEnabled: true
  });
  const files = [{ path: 'SKILL.md', content: '# Derived completion fixture\n' }];
  let preparationStartedResolve;
  let releasePreparationResolve;
  const preparationStarted = new Promise(resolve => { preparationStartedResolve = resolve; });
  const preparationGate = new Promise(resolve => { releasePreparationResolve = resolve; });
  const runPreparePublication = async input => ({ status: 200,
    prepared: { manifest: input.manifest, files, receipt: task.receipt } });
  const gatedPreparePublication = async input => {
    preparationStartedResolve();
    if (holdPreparation) await preparationGate;
    return runPreparePublication(input);
  };
  const commitGitVersion = async () => ({ repositoryId: `git_${'a'.repeat(32)}`,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), tag: 'v1' });
  const assertGitVersion = async () => undefined;
  const runPublishValidation = async () => ({ status: 200,
    report: { status: 'passed', riskLevel: 'low', summary: {}, findings: [], inventory: [] } });
  const buildPublishedPackage = async ({ submission, scanRun, sourceVersion, releaseAt }) => {
    const manifest = task.manifest;
    const payload = { manifest, files };
    const bytes = Buffer.from(`${canonicalJson({ payload })}\n`, 'utf8');
    const artifactSha256 = sha256(bytes);
    const artifactPath = path.join(tempConfig.paths.artifacts, artifactSha256.slice(0, 2), `${artifactSha256}.skillpkg`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, bytes);
    return {
      id: `pkg_${randomUUID()}`, skillId: manifest.id, skillName: manifest.name,
      displayName: manifest.displayName, version: manifest.version, status: 'published',
      packagePath: artifactPath, packageFile: `${artifactSha256}.skillpkg`,
      packageUrl: `http://skillhub.invalid/packages/${artifactSha256}`, packageSize: bytes.length,
      checksumSha256: artifactSha256, payloadSha256: sha256(Buffer.from(canonicalJson(payload))),
      manifest, submissionId: submission.id, scanRunId: scanRun.id,
      publishedAt: new Date(releaseAt).toISOString(), storageBackend: 'git-v1',
      gitRepositoryId: sourceVersion.repositoryId, gitCommitSha: sourceVersion.commitSha,
      gitTreeSha: sourceVersion.treeSha, gitTag: sourceVersion.tag, artifactSha256
    };
  };
  const baseReleaseStore = createPublicationDescriptionReleaseCommitStore(prepared.store);
  const makeWorker = (extra = {}) => createPublicationDescriptionReleaseCommitWorker({
    enabled: true, config: tempConfig, store: prepared.store,
    dependencies: {
      runPreparePublication: gatedPreparePublication, commitGitVersion, assertGitVersion,
      runPublishValidation, buildPublishedPackage,
      releaseStore: releaseStoreOverride ?? baseReleaseStore,
      ...extra
    }
  });
  return { ...prepared, task, makeWorker, tempConfig, preparationStarted,
    releasePreparation: () => releasePreparationResolve() };
}

test('PostgreSQL derived worker prepares exact retained bytes once across independent workers', pgOnly, async t => {
  const { store, f, plan, input, worker, row, count } = await workerFixture(t);
  const results = await Promise.all([worker().once(), worker().once()]);
  assert.equal(results.filter(Boolean).length, 1);
  const saved = await row();
  assert.equal(saved.state, 'committing');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.lease_token, null);
  assert.equal(saved.lease_until, null);
  assert.equal(saved.receipt.candidateHash, input.copy.expectedReceipt.derivedCandidateHash);
  assert.equal(saved.receipt.requestHash, input.copy.expectedReceipt.derivedRequestHash);
  assert.match(saved.receipt.materialHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.receipt.identity, saved.identity);
  assert.equal(saved.publication_result, null);
  assert.equal(await worker().once(), null);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('jobs'), 0);
  assert.equal(await count('skill_versions'), 0);
  const original = (await store.query('SELECT candidate,state,attempts FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0];
  assert.deepEqual(original.candidate, f.input.rawBody);
  assert.equal(original.state, 'delegated_pending');
  assert.equal(original.attempts, 0);
});

test('PostgreSQL derived worker fences an expired completion and reclaims the same target', pgOnly, async t => {
  const { store, plan, worker, row } = await workerFixture(t);
  let expire = true;
  const wrapped = { ...store, tx: fn => store.tx(client => fn({ query: async (sql, args) => {
    if (expire && sql.includes("SET state='committing'")) {
      expire = false;
      await client.query("UPDATE publication_description_release_commits SET lease_until=clock_timestamp()-interval '1 second' WHERE application_id=$1", [plan.applicationId]);
    }
    return client.query(sql, args);
  } })) };
  assert.equal(await worker({ store: wrapped }).once(), null);
  const expired = await row();
  assert.equal(expired.state, 'publishing');
  assert.equal(expired.receipt, null);
  const recovered = await worker().once();
  assert.equal(recovered.state, 'committing');
  assert.deepEqual(recovered.target, plan.target);
  assert.equal((await row()).attempts, 2);
});

test('PostgreSQL derived worker exhausts a crashed third attempt without creating publication work', pgOnly, async t => {
  const { store, plan, worker, row, count } = await workerFixture(t);
  await store.query(`UPDATE publication_description_release_commits
    SET state='publishing',attempts=3,lease_token='crashed-third-attempt',lease_until=clock_timestamp()-interval '1 second'
    WHERE application_id=$1`, [plan.applicationId]);
  assert.equal(await worker().once(), null);
  const exhausted = await row();
  assert.equal(exhausted.state, 'publish_failed');
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.error_code, 'unavailable');
  assert.equal(exhausted.lease_token, null);
  assert.equal(exhausted.lease_until, null);
  assert.equal(exhausted.receipt, null);
  assert.equal(await worker().once(), null);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('jobs'), 0);
});

test('PostgreSQL completion claims once and writes one isolated published version', pgOnly, async t => {
  const { store, makeWorker, row, count, preparationStarted, releasePreparation } =
    await completionFixture(t, { holdPreparation: true });
  const firstPromise = makeWorker().once();
  await preparationStarted;
  assert.equal(await makeWorker().once(), null);
  releasePreparation();
  assert.ok(await firstPromise);
  const saved = await row();
  assert.equal(saved.state, 'published');
  assert.equal(saved.attempts, 2);
  assert.equal(saved.lease_token, null);
  assert.ok(saved.publication_result);
  assert.equal(await count('skill_versions'), 1);
  assert.equal(await count('skill_scans'), 1);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('jobs'), 0);
  const version = (await store.query('SELECT skill_id,version,storage_backend FROM skill_versions')).rows[0];
  assert.equal(version.storage_backend, 'git-v1');
});

test('PostgreSQL completion resumes from a durable checkpoint after a worker crash', pgOnly, async t => {
  const { store, makeWorker, row, count } = await completionFixture(t);
  const base = createPublicationDescriptionReleaseCommitStore(store);
  let crashed = true;
  const releaseStore = {
    ...base,
    async complete(...args) {
      if (crashed) { crashed = false; throw new Error('simulated worker crash'); }
      return base.complete(...args);
    }
  };
  assert.equal(await makeWorker({ releaseStore }).once(), null);
  const checkpointed = await row();
  assert.equal(checkpointed.state, 'committing');
  assert.ok(checkpointed.checkpoint);
  assert.equal(checkpointed.attempts, 2);
  assert.equal(await count('skill_versions'), 0);
  assert.equal((await makeWorker().once()).state, 'published');
  assert.equal((await row()).attempts, 3);
  assert.equal(await count('skill_versions'), 1);
  assert.equal(await count('publication_commits'), 0);
});

test('PostgreSQL completion fences a lease lost after checkpoint and allows a new claimant', pgOnly, async t => {
  const { store, makeWorker, row, count } = await completionFixture(t);
  const base = createPublicationDescriptionReleaseCommitStore(store);
  let expire = true;
  const releaseStore = {
    ...base,
    async saveCheckpoint(...args) {
      const saved = await base.saveCheckpoint(...args);
      if (expire) {
        expire = false;
        await store.query("UPDATE publication_description_release_commits SET lease_until=clock_timestamp()-interval '1 second' WHERE application_id=$1",
          [args[0].application_id]);
      }
      return saved;
    }
  };
  assert.equal(await makeWorker({ releaseStore }).once(), null);
  const fenced = await row();
  assert.equal(fenced.state, 'committing');
  assert.ok(fenced.checkpoint);
  assert.ok(fenced.lease_token);
  assert.equal(await count('skill_versions'), 0);
  assert.equal((await makeWorker().once()).state, 'published');
  assert.equal(await count('skill_versions'), 1);
});

test('PostgreSQL completion rejects owner changes terminally without legacy publication', pgOnly, async t => {
  const { store, f, makeWorker, row, count } = await completionFixture(t);
  await store.query("UPDATE users SET status='suspended' WHERE id=$1", [f.owner]);
  assert.equal(await makeWorker().once(), null);
  const rejected = await row();
  assert.equal(rejected.state, 'publish_failed');
  assert.equal(rejected.error_code, 'skillhub.publication_description_release_commit_publisher_changed');
  assert.equal(await count('skill_versions'), 0);
  assert.equal(await count('skill_scans'), 0);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('jobs'), 0);
});

test('PostgreSQL completion marks the third expired attempt failed and never requeues it', pgOnly, async t => {
  const { store, makeWorker, row, count } = await completionFixture(t);
  await store.query(`UPDATE publication_description_release_commits
    SET attempts=3,lease_token='crashed-third-attempt',lease_until=clock_timestamp()-interval '1 second'
    WHERE application_id=$1`, [(await row()).application_id]);
  assert.equal(await makeWorker().once(), null);
  const exhausted = await row();
  assert.equal(exhausted.state, 'publish_failed');
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.error_code, 'unavailable');
  assert.equal(await makeWorker().once(), null);
  assert.equal(await count('skill_versions'), 0);
  assert.equal(await count('publication_commits'), 0);
});

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

async function httpAuthorize(config, store, input, { auth = secret, releasePermitClient } = {}) {
  const handler = createPublicationDescriptionDerivationHandler(config, store, { releasePermitClient });
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: PUBLICATION_DESCRIPTION_AUTHORIZE_PATH,
        method: 'POST', headers: { Host: 'cloud.invalid', 'X-Forwarded-Proto': 'https', Authorization: 'Bearer ' + auth,
          'Content-Type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
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

test('PostgreSQL derived release permit creates a durable cancellation fence before peer I/O and recovers lost replies', pgOnly, async t => {
  const { config, store, f, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const activeConfig = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation,
    enabled: true, planEnabled: true, issuer, audience, peerSecret: secret, trustedProxyAddresses: ['127.0.0.1'],
    releasePermit: { enabled: true, issuer, audience, peerSecret: 'c'.repeat(64) } } };
  const authorizeInput = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  const requestFor = () => ({ schemaVersion: 1, entryId: plan.publicationReceipt.entryRequestId,
    applicationId: plan.applicationId, target: plan.target });
  let calls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const permitClient = { async authorize(request) {
    calls++;
    assert.deepEqual(request, requestFor());
    if (calls === 1) { await waiting; throw new PublicationDescriptionReleasePermitError('unavailable'); }
    return permitFor(request);
  } };
  const consumer = planner({ config: activeConfig, releasePermitEnabled: true, permitClient });
  const authorizing = consumer.authorize(authorizeInput);
  for (let index = 0; index < 100; index++) {
    if (await count('publication_description_release_authorizations')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await count('publication_description_release_authorizations'), 1);
  const pending = (await store.query('SELECT state,proof FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0];
  assert.equal(pending.state, 'pending'); assert.equal(pending.proof, null);
  const control = createDelegatedPublicationControlStore({ enabled: true, store, issuer, audience });
  await assert.rejects(control.cancel(f.receipt), { code: 'skillhub.publication_control_conflict' });
  release();
  await assert.rejects(authorizing, code('unavailable'));
  assert.equal((await store.query('SELECT state FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0].state, 'pending');
  await assert.rejects(control.cancel(f.receipt), { code: 'skillhub.publication_control_conflict' });
  await store.query(`UPDATE publication_description_release_authorizations
    SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE application_id=$1`, [plan.applicationId]);
  const recovered = await consumer.authorize(authorizeInput);
  assert.equal(recovered.replayed, false); assert.deepEqual(recovered.permit, permitFor(requestFor()));
  assert.equal(calls, 2);
  assert.deepEqual(await consumer.authorize(authorizeInput), { ...recovered, replayed: true });
  assert.equal(calls, 2);
  assert.equal((await store.query('SELECT state,proof FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0].state, 'permitted');
  assert.equal(await count('publication_description_release_admissions'), 1);
  const admission = (await store.query('SELECT * FROM publication_description_release_admissions WHERE application_id=$1', [plan.applicationId])).rows[0];
  assert.equal(admission.task_id, f.receipt.taskId); assert.equal(admission.permit_id, recovered.permit.permitId);
  assert.deepEqual(admission.proof, recovered.permit);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('publication_delegated_permits'), 0);
  await assert.rejects(control.cancel(f.receipt), { code: 'skillhub.publication_control_conflict' });
  for (const sql of ['UPDATE publication_description_release_authorizations SET proof=proof', 'DELETE FROM publication_description_release_authorizations']) {
    await assert.rejects(store.query(sql + ' WHERE application_id=$1', [plan.applicationId]), { code: '23514' });
  }
  await assert.rejects(store.query(`UPDATE publication_tasks SET state='cancelled',delegated_cancelled_at=now(),candidate=NULL,candidate_bytes=0 WHERE id=$1`,
    [f.receipt.taskId]), { code: '23514' });
  for (const sql of ['UPDATE publication_description_release_admissions SET proof=proof',
    'DELETE FROM publication_description_release_admissions']) {
    await assert.rejects(store.query(sql + ' WHERE application_id=$1', [plan.applicationId]), { code: '23514' });
  }
});

for (const kind of ['denied', 'cancelled', 'conflict']) test(`PostgreSQL terminal ${kind} releases the Cloud cancellation fence without publishing`, pgOnly, async t => {
  const { config, store, f, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const activeConfig = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation, planEnabled: true } };
  const permitClient = { async authorize() { throw new PublicationDescriptionReleasePermitError(kind); } };
  const consumer = planner({ config: activeConfig, releasePermitEnabled: true, permitClient });
  const authorizeInput = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  await assert.rejects(consumer.authorize(authorizeInput), code(kind));
  const terminal = (await store.query('SELECT state,terminal_code FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0];
  assert.deepEqual(terminal, { state: 'denied', terminal_code: kind });
  const control = createDelegatedPublicationControlStore({ enabled: true, store, issuer, audience });
  assert.equal((await control.cancel(f.receipt)).executionState, 'cancelled');
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('publication_delegated_permits'), 0);
});

test('PostgreSQL concurrent authorize retries retain one exact permit and keep cancellation fenced', pgOnly, async t => {
  const { config, store, f, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const request = { schemaVersion: 1, entryId: plan.publicationReceipt.entryRequestId,
    applicationId: plan.applicationId, target: plan.target };
  let calls = 0, release, start;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { start = resolve; });
  const consumer = planner({ config: { ...config, publicationDescriptionDerivation: {
    ...config.publicationDescriptionDerivation, planEnabled: true } }, releasePermitEnabled: true,
  permitClient: { async authorize(value) { calls++; assert.deepEqual(value, request); start(); await pending; return permitFor(value); } } });
  const body = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  const firstRequest = consumer.authorize(body);
  await started;
  await assert.rejects(consumer.authorize(body), code('busy'));
  release();
  const first = await firstRequest;
  const second = await consumer.authorize(body);
  assert.deepEqual(first.permit, permitFor(request));
  assert.deepEqual(second.permit, first.permit);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.equal((await store.query('SELECT state FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0].state, 'permitted');
  const control = createDelegatedPublicationControlStore({ enabled: true, store, issuer, audience });
  await assert.rejects(control.cancel(f.receipt), { code: 'skillhub.publication_control_conflict' });
  assert.equal(await count('publication_description_release_authorizations'), 1);
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('publication_delegated_permits'), 0);
});

test('PostgreSQL expired permit-attempt lease fences a late response from the previous claimant', pgOnly, async t => {
  const { config, store, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const activeConfig = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation,
    planEnabled: true } };
  const body = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  const gates = [], started = [], calls = [];
  const makeConsumer = () => {
    let open, begin;
    const gate = new Promise(resolve => { open = resolve; });
    const began = new Promise(resolve => { begin = resolve; });
    gates.push(open); started.push(began);
    return { consumer: planner({ config: activeConfig, releasePermitEnabled: true, permitClient: {
      async authorize(request) { calls.push(request); begin(); await gate; return permitFor(request); }
    } }), started: began };
  };
  const first = makeConsumer(), firstRequest = first.consumer.authorize(body);
  await first.started;
  for (let index = 0; index < 100; index++) {
    if (await count('publication_description_release_authorizations')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await count('publication_description_release_authorizations'), 1);
  await store.query(`UPDATE publication_description_release_authorizations
    SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE application_id=$1`, [plan.applicationId]);
  const second = makeConsumer(), secondRequest = second.consumer.authorize(body);
  await second.started;
  assert.equal(calls.length, 2);
  gates[0]();
  await assert.rejects(firstRequest, code('conflict'));
  assert.equal((await store.query('SELECT state,attempt_lease_until>clock_timestamp() AS leased FROM publication_description_release_authorizations WHERE application_id=$1',
    [plan.applicationId])).rows[0].leased, true);
  gates[1]();
  const result = await secondRequest;
  assert.equal(result.replayed, false);
  assert.deepEqual(result.permit, permitFor(calls[1]));
  assert.equal((await store.query('SELECT state FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0].state, 'permitted');
  assert.equal(await count('publication_commits'), 0);
});

test('PostgreSQL direct cancellation serializes behind a pending permit fence', pgOnly, async t => {
  const { store, f, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  let unlock, acquired;
  const gate = new Promise(resolve => { unlock = resolve; });
  let failedAcquire;
  const locked = new Promise((resolve, reject) => { acquired = resolve; failedAcquire = reject; });
  const authorizing = store.tx(async c => {
    try {
      await c.query('SELECT id FROM publication_tasks WHERE id=$1 FOR UPDATE', [f.receipt.taskId]);
      await c.query(`INSERT INTO publication_description_release_authorizations
        (application_id,task_id,state,attempt_token,attempt_lease_until)
        VALUES($1,$2,'pending',$3,clock_timestamp()+interval '15 seconds')`,
      [plan.applicationId, f.receipt.taskId, `pubdescattempt_${randomUUID()}`]);
      acquired();
      await gate;
    } catch (error) {
      failedAcquire(error);
      throw error;
    }
  });
  let cancellation;
  try {
    await locked;
    cancellation = store.query(`UPDATE publication_tasks SET state='cancelled',delegated_cancelled_at=clock_timestamp(),
      candidate=NULL,candidate_bytes=0,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`, [f.receipt.taskId]);
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    unlock();
    await authorizing.catch(() => {});
  }
  await assert.rejects(cancellation, { code: '23514' });
  assert.equal((await store.query('SELECT state FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0].state, 'delegated_pending');
  assert.equal((await store.query('SELECT state FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0].state, 'pending');
  assert.equal(await count('publication_commits'), 0);
});

test('PostgreSQL late derived permit is retained after expiry and historical replay never recharges quota', pgOnly, async t => {
  const { config, store, f, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const activeConfig = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation, planEnabled: true } };
  let calls = 0;
  const permitClient = { async authorize(request) {
    calls++;
    await store.query("UPDATE publication_tasks SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.receipt.taskId]);
    await store.query("UPDATE publisher_profiles SET status='suspended' WHERE id=$1", [f.profile.id]);
    return permitFor(request);
  } };
  const body = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  const first = await planner({ config: activeConfig, releasePermitEnabled: true, permitClient }).authorize(body);
  assert.equal(first.replayed, false);
  assert.equal(await count('publication_description_release_admissions'), 1);
  const before = (await store.query('SELECT commit_bytes FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0].commit_bytes;
  const full = { ...activeConfig, publicationTasks: { ...config.publicationTasks, maxStoredBytes: 1 } };
  assert.deepEqual(await planner({ config: full, releasePermitEnabled: true, permitClient }).authorize(body), { ...first, replayed: true });
  assert.equal((await store.query('SELECT commit_bytes FROM publication_tasks WHERE id=$1', [f.receipt.taskId])).rows[0].commit_bytes, before);
  assert.equal(calls, 1);
  assert.equal(await count('publication_commits'), 0);
});

test('PostgreSQL migration preserves pre-admission permits without backfill or fresh execution checks', pgOnly, async t => {
  const { config, store, f, input, planner, count } = await fixture(t, { beforeAdmissionMigration: true });
  const plan = await planner().plan(input);
  const proof = permitFor({ entryId: f.receipt.entryRequestId, applicationId: plan.applicationId, target: plan.target });
  await store.query(`INSERT INTO publication_description_release_authorizations
    (application_id,task_id,state,attempt_token,attempt_lease_until)
    VALUES($1,$2,'pending',$3,clock_timestamp()+interval '15 seconds')`,
  [plan.applicationId, f.receipt.taskId, 'pubdescattempt_' + randomUUID()]);
  await store.query(`UPDATE publication_description_release_authorizations
    SET state='permitted',proof=$2,attempt_token=NULL,attempt_lease_until=NULL WHERE application_id=$1`,
  [plan.applicationId, JSON.stringify(proof)]);
  await store.query(await fs.readFile(new URL('../../infra/migrations/023_publication_description_release_admissions.sql', import.meta.url), 'utf8'));
  await store.query("UPDATE publication_tasks SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.receipt.taskId]);
  const activeConfig = { ...config, publicationTasks: { ...config.publicationTasks, maxStoredBytes: 1 },
    publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation, planEnabled: true } };
  const permitClient = { async authorize() { assert.fail('historical replay must not request a new permit'); } };
  const result = await planner({ config: activeConfig, releasePermitEnabled: true, permitClient }).authorize({
    schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt });
  assert.deepEqual(result, { schemaVersion: 1, applicationId: plan.applicationId, permit: proof, replayed: true });
  assert.equal(await count('publication_description_release_admissions'), 0);
  assert.equal(await count('publication_commits'), 0);
});

test('PostgreSQL admission quota failure rolls back local permit and marker then recovers the exact remote outcome', pgOnly, async t => {
  const { config, store, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const activeConfig = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation, planEnabled: true } };
  const body = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  const permitClient = { async authorize(request) { return permitFor(request); } };
  // Use an independent low-budget consumer to recover a pending attempt.
  await assert.rejects(planner({ config: activeConfig, releasePermitEnabled: true,
    permitClient: { async authorize() { throw new PublicationDescriptionReleasePermitError('unavailable'); } } }).authorize(body), code('unavailable'));
  await store.query("UPDATE publication_description_release_authorizations SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE application_id=$1", [plan.applicationId]);
  const small = { ...activeConfig, publicationTasks: { ...config.publicationTasks, maxStoredBytes: 1 } };
  await assert.rejects(planner({ config: small, releasePermitEnabled: true, permitClient }).authorize(body), code('storage_limit'));
  assert.equal((await store.query('SELECT state FROM publication_description_release_authorizations WHERE application_id=$1', [plan.applicationId])).rows[0].state, 'pending');
  assert.equal(await count('publication_description_release_admissions'), 0);
  await store.query("UPDATE publication_description_release_authorizations SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE application_id=$1", [plan.applicationId]);
  const recovered = await planner({ config: activeConfig, releasePermitEnabled: true,
    permitClient: { async authorize(request) { return permitFor(request); } } }).authorize(body);
  assert.equal(recovered.replayed, false);
  assert.equal(await count('publication_description_release_admissions'), 1);
  assert.equal(await count('publication_commits'), 0);
});

test('description authorize route is independently gated and uses only stored plan target', pgOnly, async t => {
  const { config, store, input, planner, count } = await fixture(t);
  const plan = await planner().plan(input);
  const body = { schemaVersion: 1, applicationId: plan.applicationId, publicationReceipt: plan.publicationReceipt };
  const base = { ...config, publicationDescriptionDerivation: { ...config.publicationDescriptionDerivation,
    enabled: true, planEnabled: true, issuer, audience, peerSecret: secret, trustedProxyAddresses: ['127.0.0.1'],
    releasePermit: { enabled: false } } };
  assert.equal((await httpAuthorize(base, store, body)).status, 404);
  const active = { ...base, publicationDescriptionDerivation: { ...base.publicationDescriptionDerivation,
    releasePermit: { enabled: true, issuer, audience, peerSecret: 'c'.repeat(64) } } };
  assert.equal((await httpAuthorize(active, store, body, { auth: 'wrong' })).status, 401);
  const calls = [];
  const releasePermitClient = { async authorize(request) { calls.push(request); return permitFor(request); } };
  assert.equal((await httpAuthorize(active, store, { ...body, target: plan.target }, { releasePermitClient })).status, 400);
  assert.equal((await httpAuthorize(active, store, { ...body, applicationId: 'pubdesc_' + 'f'.repeat(64) }, { releasePermitClient })).status, 409);
  assert.equal(calls.length, 0);
  const result = await httpAuthorize(active, store, body, { releasePermitClient: { async authorize(request) {
    calls.push(request); return permitFor(request);
  } } });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ schemaVersion: 1, entryId: plan.publicationReceipt.entryRequestId,
    applicationId: plan.applicationId, target: plan.target }]);
  assert.deepEqual(result.body, { schemaVersion: 1, applicationId: plan.applicationId, permit: permitFor(calls[0]), replayed: false });
  assert.equal(await count('publication_commits'), 0);
  assert.equal(await count('publication_delegated_permits'), 0);
  assert.equal(await count('publication_description_release_authorizations'), 1);
  assert.equal(await count('publication_description_release_admissions'), 1);
});
