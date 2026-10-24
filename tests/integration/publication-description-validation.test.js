import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePublicationDescriptionCopy } from '../../packages/publication-description-derivations/read.js';
import { effectiveLimits } from '../../packages/publish-validation/index.js';
import { descriptionCopyFixture } from '../helpers/description-copy.js';

const limits = effectiveLimits();
const code = kind => ({ code: 'skillhub.publication_description_derivation_' + kind });
const storeFor = f => ({ async getPublicationDescriptionDerivation() { return f.row; },
  async getPublicationDescriptionDerivationSource() { return f.source; } });

test('private copy validation reports on the retained derived package without writes or private bytes', async () => {
  const f = descriptionCopyFixture(), before = structuredClone(f);
  const first = await validatePublicationDescriptionCopy(storeFor(f), f.request, limits);
  const second = await validatePublicationDescriptionCopy(storeFor(f), f.request, limits);
  assert.deepEqual(Object.keys(first).sort(), ['applicationId', 'derivedBytes', 'receipt', 'schemaVersion', 'taskId', 'validation']);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.applicationId, f.request.applicationId);
  assert.equal(first.taskId, f.request.taskId);
  assert.equal(first.derivedBytes, f.request.derivedBytes);
  assert.deepEqual(first.receipt, f.request.expectedReceipt);
  assert.equal(first.validation.candidateHash, first.receipt.derivedCandidateHash);
  assert.notEqual(first.validation.candidateHash, f.request.candidateHash);
  assert.equal(first.validation.outcome, 'passed');
  assert.equal(first.validation.coverage, 'complete');
  assert.equal(first.validation.truncated, false);
  assert.equal(first.validation.limitsFingerprint, first.receipt.limitsFingerprint);
  assert.notEqual(first.validation.reportId, second.validation.reportId);
  const comparable = value => { const copy = structuredClone(value); delete copy.validation.reportId; return copy; };
  assert.deepEqual(comparable(first), comparable(second));
  for (const privateText of ['PRIVATE', 'contentBase64', f.request.proposal.text, 'private.bin']) {
    assert.equal(JSON.stringify(first).includes(privateText), false);
  }
  assert.deepEqual(structuredClone(f), before);
});

test('validation rejects caller reports, selectors and substituted receipt before reading storage', async () => {
  const f = descriptionCopyFixture(); let reads = 0;
  const store = { getPublicationDescriptionDerivation() { reads++; throw Error('must not read'); } };
  for (const input of [null, {}, { ...f.request, validation: {} },
    { ...f.request, proposal: { ...f.request.proposal, relativePath: 'README.md' } }]) {
    await assert.rejects(validatePublicationDescriptionCopy(store, input, limits), code('invalid'));
  }
  assert.equal(reads, 0);
  await assert.rejects(validatePublicationDescriptionCopy(storeFor(f),
    { ...f.request, expectedReceipt: { ...f.request.expectedReceipt, derivedCandidateHash: '0'.repeat(64) } }, limits), code('conflict'));
});

test('validation rejects missing, corrupted or differently bound retained copies', async () => {
  const f = descriptionCopyFixture();
  await assert.rejects(validatePublicationDescriptionCopy(storeFor({ ...f, row: null }), f.request, limits), code('copy_unavailable'));
  for (const change of [{ application_id: 'pubdesc_' + '0'.repeat(64) },
    { derived_bytes: f.request.derivedBytes + 1 }, { derived_raw_json: Buffer.alloc(f.request.derivedBytes) },
    { derivation_receipt: { ...f.request.expectedReceipt, validationDigest: '0'.repeat(64) } }]) {
    await assert.rejects(validatePublicationDescriptionCopy(storeFor({ ...f, row: { ...f.row, ...change } }), f.request, limits));
  }
});

test('validation requires the original source and checks cancellation after the bounded worker', async () => {
  const f = descriptionCopyFixture();
  for (const change of [{ state: 'cancelled' }, { expires_at: new Date(0) }, { commit_started: true },
    { candidate: null, candidate_bytes: 0 }, { request_hash: '0'.repeat(64) }]) {
    await assert.rejects(validatePublicationDescriptionCopy(storeFor({ ...f, source: { ...f.source, ...change } }), f.request, limits), code('source_unavailable'));
  }
  let reads = 0;
  const store = { ...storeFor(f), async getPublicationDescriptionDerivationSource() {
    return ++reads === 1 ? f.source : { ...f.source, state: 'cancelled' };
  } };
  await assert.rejects(validatePublicationDescriptionCopy(store, f.request, limits), code('source_unavailable'));
  assert.equal(reads, 2);
});

test('validation fails on report or current-limit drift instead of approving a different package', async () => {
  const f = descriptionCopyFixture();
  await assert.rejects(validatePublicationDescriptionCopy(storeFor(f), f.request,
    { ...limits, maxFiles: limits.maxFiles + 1 }), code('copy_changed'));
  f.source.intake_result.body.error.validation.truncated = true;
  await assert.rejects(validatePublicationDescriptionCopy(storeFor(f), f.request, limits), code('copy_changed'));
});

test('validation snapshots caller bindings and does not return a report after cancellation', async () => {
  const f = descriptionCopyFixture(), id = f.request.applicationId;
  const store = { ...storeFor(f), async getPublicationDescriptionDerivation() {
    f.request.applicationId = 'pubdesc_' + '0'.repeat(64); return f.row;
  } };
  const report = await validatePublicationDescriptionCopy(store, f.request, limits);
  assert.equal(report.applicationId, id);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(validatePublicationDescriptionCopy(store, f.request, limits,
    { signal: controller.signal }), code('unavailable'));
});
