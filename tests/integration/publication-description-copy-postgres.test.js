import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../../packages/config/index.js';
import { effectiveLimits } from '../../packages/publish-validation/index.js';
import { createPublicationDescriptionDerivationStore } from '../../packages/publication-description-derivations/store.js';
import { readPublicationDescriptionCopy, validatePublicationDescriptionCopy } from '../../packages/publication-description-derivations/read.js';
import { createPublicationDescriptionDerivationHandler, PUBLICATION_DESCRIPTION_DERIVATION_PATH,
  PUBLICATION_DESCRIPTION_READ_PATH, PUBLICATION_DESCRIPTION_VALIDATE_PATH } from '../../apps/api/publication-description-derivation.js';
import { descriptionCopyFixture } from '../helpers/description-copy.js';

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;
const options = { skip: !databaseUrl };
const limits = effectiveLimits();
const secret = 'pubderive_' + 'a'.repeat(64);
const settings = loadConfig({ publicationTasksEnabled: true, publicationDescriptionDerivationEnabled: true,
  publicationDescriptionReadEnabled: true, publicationDescriptionValidationEnabled: true,
  publicationDescriptionDerivationIssuer: 'https://cats.example',
  publicationDescriptionDerivationAudience: 'https://cloud.example', publicationDescriptionDerivationPeerSecret: secret,
  publicationDescriptionDerivationTrustedProxyAddresses: ['127.0.0.1'] });

async function fixture(t) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(async () => { await client.query('ROLLBACK'); await client.end(); });
  await client.query('BEGIN');
  const f = descriptionCopyFixture(), owner = 'description-copy-' + randomUUID();
  await client.query(`INSERT INTO users(id,email,password_hash,display_name)
    VALUES($1,$2,'fixture','Copy recovery test')`, [owner, owner + '@example.invalid']);
  // Explicit store contract fixture: real PG constraints/retention/validator,
  // synthetic prior authority. This is not a CatsCo/live-Runtime repair E2E.
  await client.query(`INSERT INTO publication_tasks(id,owner_user_id,request_key,request_hash,candidate_hash,
    candidate,candidate_bytes,state,intake_result,expires_at,purge_after,authority_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,'delegated_pending',$8,now()+interval '5 minutes',now()+interval '1 hour','catsco')`,
  [f.request.taskId, owner, randomUUID(), f.request.requestHash, f.request.candidateHash,
    f.source.candidate, f.source.candidate.length, JSON.stringify(f.source.intake_result)]);
  const query = (sql, args) => client.query(sql, args);
  const recreate = () => createPublicationDescriptionDerivationStore({ query, tx: fn => fn(client) });
  return { ...f, client, store: recreate(), recreate };
}

async function httpCall(store, path, input, drop = false) {
  const handler = createPublicationDescriptionDerivationHandler(settings, store);
  const server = http.createServer((req, res) => {
    if (drop) res.end = () => res.destroy(); // Persist first, then really lose the HTTP reply.
    void handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
        headers: { Host: 'cloud.example', 'X-Forwarded-Proto': 'https', Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end(JSON.stringify(input));
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('PostgreSQL retains on lost HTTP reply and recreated handlers recover the exact private copy', options, async t => {
  const f = await fixture(t);
  const { expectedReceipt, derivedBytes, ...deriveInput } = f.request;
  await assert.rejects(httpCall(f.store, PUBLICATION_DESCRIPTION_DERIVATION_PATH, deriveInput, true), { code: 'ECONNRESET' });
  const count = async () => Number((await f.client.query('SELECT count(*) FROM publication_description_derivations WHERE task_id=$1', [f.request.taskId])).rows[0].count);
  assert.equal(await count(), 1);
  const checked = await httpCall(f.recreate(), PUBLICATION_DESCRIPTION_VALIDATE_PATH, f.request);
  assert.equal(checked.status, 200, checked.bytes.toString());
  const report = JSON.parse(checked.bytes);
  assert.equal(report.applicationId, f.request.applicationId);
  assert.deepEqual(report.receipt, expectedReceipt);
  assert.equal(report.validation.candidateHash, expectedReceipt.derivedCandidateHash);
  assert.equal(report.validation.outcome, 'passed');
  assert.equal(checked.bytes.includes('PRIVATE'), false);
  assert.equal(await count(), 1);
  const metadata = await httpCall(f.recreate(), PUBLICATION_DESCRIPTION_DERIVATION_PATH, deriveInput);
  assert.equal(metadata.status, 200);
  const replay = JSON.parse(metadata.bytes);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, expectedReceipt);
  assert.equal(replay.derivedBytes, derivedBytes);
  for (let i = 0; i < 2; i++) {
    const read = await httpCall(f.recreate(), PUBLICATION_DESCRIPTION_READ_PATH, f.request);
    assert.equal(read.status, 200, read.bytes.toString());
    assert.deepEqual(read.bytes, f.row.derived_raw_json);
  }
  assert.equal(await count(), 1);
  const task = (await f.client.query('SELECT candidate,state,attempts FROM publication_tasks WHERE id=$1', [f.request.taskId])).rows[0];
  assert.deepEqual(task.candidate, f.source.candidate);
  assert.equal(task.state, 'delegated_pending');
  assert.equal(task.attempts, 0);
  for (const sql of ['UPDATE publication_description_derivations SET derived_bytes=derived_bytes', 'DELETE FROM publication_description_derivations']) {
    await f.client.query('SAVEPOINT immutable_test');
    await assert.rejects(f.client.query(sql + ' WHERE application_id=$1', [f.request.applicationId]), { code: '23514' });
    await f.client.query('ROLLBACK TO SAVEPOINT immutable_test');
  }
});

test('PostgreSQL recovery rejects changed bindings, cancellation and expired original source', options, async t => {
  const f = await fixture(t);
  await f.store.retainPublicationDescriptionDerivation({ applicationId: f.request.applicationId,
    taskId: f.request.taskId, proposal: f.request.proposal, derived: f.derived.derived });
  await assert.rejects(readPublicationDescriptionCopy(f.recreate(), { ...f.request,
    applicationId: 'pubdesc_' + '0'.repeat(64) }, limits), { code: 'skillhub.publication_description_derivation_copy_unavailable' });
  await assert.rejects(readPublicationDescriptionCopy(f.recreate(), { ...f.request,
    expectedReceipt: { ...f.request.expectedReceipt, validationDigest: '0'.repeat(64) } }, limits),
  { code: 'skillhub.publication_description_derivation_conflict' });
  await f.client.query('SAVEPOINT expiry_test');
  await f.client.query("UPDATE publication_tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [f.request.taskId]);
  await assert.rejects(readPublicationDescriptionCopy(f.recreate(), f.request, limits),
    { code: 'skillhub.publication_description_derivation_source_unavailable' });
  await assert.rejects(validatePublicationDescriptionCopy(f.recreate(), f.request, limits),
    { code: 'skillhub.publication_description_derivation_source_unavailable' });
  await f.client.query('ROLLBACK TO SAVEPOINT expiry_test');
  await f.client.query("UPDATE publication_tasks SET state='cancelled',delegated_cancelled_at=now(),candidate=NULL,candidate_bytes=0 WHERE id=$1", [f.request.taskId]);
  await assert.rejects(readPublicationDescriptionCopy(f.recreate(), f.request, limits),
    { code: 'skillhub.publication_description_derivation_source_unavailable' });
  const cancelled = await httpCall(f.recreate(), PUBLICATION_DESCRIPTION_VALIDATE_PATH, f.request);
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.bytes.includes('PRIVATE'), false);
  assert.equal((await f.store.getPublicationDescriptionDerivation(f.request.applicationId)).derived_bytes, String(f.request.derivedBytes));
});
