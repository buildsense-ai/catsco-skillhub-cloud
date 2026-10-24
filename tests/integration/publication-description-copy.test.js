import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readPublicationDescriptionCopy, validDescriptionCopyRead } from '../../packages/publication-description-derivations/read.js';
import { effectiveLimits, validatePublishRequest } from '../../packages/publish-validation/index.js';
import { descriptionCopyFixture } from '../helpers/description-copy.js';

const limits = effectiveLimits();
const code = kind => ({ code: 'skillhub.publication_description_derivation_' + kind });
const storeFor = f => ({ async getPublicationDescriptionDerivation() { return f.row; },
  async getPublicationDescriptionDerivationSource() { return f.source; } });

test('private copy recovery returns exact retained bytes repeatedly without writes', async () => {
  const f = descriptionCopyFixture(), store = storeFor(f);
  const before = structuredClone(f);
  for (let i = 0; i < 3; i++) assert.deepEqual(await readPublicationDescriptionCopy(store, f.request, limits), f.row.derived_raw_json);
  assert.deepEqual(structuredClone(f), before);
});

test('private copy read validates exact schema, selectors, expected receipt and byte bounds before storage', async () => {
  const f = descriptionCopyFixture();
  let calls = 0;
  const store = { getPublicationDescriptionDerivation() { calls++; throw Error('must not read'); } };
  const invalid = [null, {}, { ...f.request, token: 'forged' }, { ...f.request, schemaVersion: 2 },
    { ...f.request, derivedBytes: 0 }, { ...f.request, derivedBytes: limits.maxRequestBytes + 1 },
    { ...f.request, derivedBytes: '42' }, { ...f.request, proposal: { ...f.request.proposal, relativePath: 'skill.json' } },
    { ...f.request, expectedReceipt: { ...f.request.expectedReceipt, extra: true } },
    ...Object.keys(f.request.expectedReceipt).map(key => ({ ...f.request,
      expectedReceipt: { ...f.request.expectedReceipt, [key]: 'bad' } }))];
  for (const input of invalid) await assert.rejects(readPublicationDescriptionCopy(store, input, limits), code('invalid'));
  assert.equal(calls, 0);
  assert.equal(validDescriptionCopyRead(f.request), true);
});

test('missing copy and any changed retained binding fail without returning private bytes', async () => {
  const f = descriptionCopyFixture();
  await assert.rejects(readPublicationDescriptionCopy(storeFor({ ...f, row: null }), f.request, limits), code('copy_unavailable'));
  const changes = { application_id: 'pubdesc_' + '0'.repeat(64), task_id: 'pubtask_bad', request_hash: '0'.repeat(64),
    candidate_hash: '0'.repeat(64), proposal: { ...f.request.proposal, text: 'different' }, proposal_digest: '0'.repeat(64),
    derived_request_hash: '0'.repeat(64), derived_candidate_hash: '0'.repeat(64), derived_bytes: f.request.derivedBytes + 1,
    derivation_receipt: { ...f.request.expectedReceipt, validationDigest: '0'.repeat(64) } };
  for (const [key, value] of Object.entries(changes)) {
    await assert.rejects(readPublicationDescriptionCopy(storeFor({ ...f, row: { ...f.row, [key]: value } }), f.request, limits), code('conflict'));
  }
  await assert.rejects(readPublicationDescriptionCopy(storeFor({ ...f,
    row: { ...f.row, derived_raw_json: Buffer.alloc(f.request.derivedBytes) } }), f.request, limits), code('copy_changed'));
});

test('cancelled, expired, purged, changed and already committing sources fail closed', async () => {
  const f = descriptionCopyFixture();
  const changes = [null, ...Object.entries({ id: 'pubtask_other', authority_kind: 'account',
    state: 'cancelled', commit_started: true, expires_at: new Date(0),
    candidate: null, candidate_bytes: 0, candidate_hash: '0'.repeat(64), request_hash: '0'.repeat(64) })
    .map(([key, value]) => ({ ...f.source, [key]: value })),
    { ...f.source, candidate: Buffer.alloc(f.source.candidate.length) }];
  for (const source of changes) {
    await assert.rejects(readPublicationDescriptionCopy(storeFor({ ...f, source }), f.request, limits), code('source_unavailable'));
  }
});

test('recovery rederives exact package rather than trusting a substituted but rehashed copy', async () => {
  const f = descriptionCopyFixture();
  const body = JSON.parse(f.row.derived_raw_json.toString());
  body.source.files[0].contentBase64 = Buffer.from(Buffer.from(body.source.files[0].contentBase64, 'base64')
    .toString().replace('PRIVATE', 'FORGED!')).toString('base64');
  const changed = JSON.stringify(body);
  f.row.derived_raw_json = Buffer.from(changed);
  f.row.derived_bytes = f.request.derivedBytes = Buffer.byteLength(changed);
  const digest = createHash('sha256').update(changed).digest('hex');
  f.row.derived_request_hash = f.request.expectedReceipt.derivedRequestHash = digest;
  f.row.derived_candidate_hash = f.request.expectedReceipt.derivedCandidateHash = validatePublishRequest(changed).body.validation.candidateHash;
  await assert.rejects(readPublicationDescriptionCopy(storeFor(f), f.request, limits), code('copy_changed'));
});

test('source is rechecked after worker and abort never returns private bytes', async () => {
  const f = descriptionCopyFixture();
  let reads = 0;
  const store = { ...storeFor(f), async getPublicationDescriptionDerivationSource() {
    return ++reads === 1 ? f.source : { ...f.source, state: 'cancelled' };
  } };
  await assert.rejects(readPublicationDescriptionCopy(store, f.request, limits), code('source_unavailable'));
  assert.equal(reads, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readPublicationDescriptionCopy(storeFor(f), f.request, limits, { signal: controller.signal }), code('unavailable'));
});

test('original input is snapshotted before await and changed validation/rules fail rederivation', async () => {
  const f = descriptionCopyFixture();
  const expected = Buffer.from(f.row.derived_raw_json);
  const store = { ...storeFor(f), async getPublicationDescriptionDerivation() {
    f.request.taskId = 'pubtask_changed';
    return f.row;
  } };
  assert.deepEqual(await readPublicationDescriptionCopy(store, f.request, limits), expected);
  const other = descriptionCopyFixture();
  other.source.intake_result.body.error.validation.truncated = true;
  await assert.rejects(readPublicationDescriptionCopy(storeFor(other), other.request, limits), code('copy_changed'));
});
