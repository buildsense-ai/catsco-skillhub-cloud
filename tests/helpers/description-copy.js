import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { derivePublicationDescription } from '../../packages/publication-tasks/description-derivation.js';

// Real validator/transformer bytes; only persistence/authority are synthetic.
export function descriptionCopyFixture() {
  const rawJson = JSON.stringify({ source: { type: 'files', files: [
    { path: 'SKILL.md', content: '---\nname: recovery-fixture\n---\nPRIVATE instructions stay unchanged.\n' },
    { path: 'assets/private.bin', contentBase64: Buffer.from([0, 255, 128, 13, 10]).toString('base64') }
  ] } });
  const validation = validatePublishRequest(rawJson);
  assert.equal(validation.status, 422);
  const original = { rawJson, requestHash: createHash('sha256').update(rawJson).digest('hex'),
    candidateHash: validation.body.error.validation.candidateHash, validation: validation.body.error.validation,
    proposal: { relativePath: 'SKILL.md', field: 'description', entryIndex: 0, text: 'Read <docs> & preserve 中文😀.' } };
  const derived = derivePublicationDescription(original);
  assert.equal(derived.status, 200, JSON.stringify(derived.body));
  const request = { schemaVersion: 1, applicationId: 'pubdesc_' + createHash('sha256').update(randomUUID()).digest('hex'),
    taskId: 'pubtask_' + randomUUID(), requestHash: original.requestHash, candidateHash: original.candidateHash,
    proposal: original.proposal, expectedReceipt: derived.derived.receipt,
    derivedBytes: Buffer.byteLength(derived.derived.rawJson) };
  const row = { application_id: request.applicationId, task_id: request.taskId,
    request_hash: request.requestHash, candidate_hash: request.candidateHash, proposal: request.proposal,
    proposal_digest: request.expectedReceipt.proposalDigest, derived_request_hash: request.expectedReceipt.derivedRequestHash,
    derived_candidate_hash: request.expectedReceipt.derivedCandidateHash, derived_raw_json: Buffer.from(derived.derived.rawJson),
    derived_bytes: String(request.derivedBytes), derivation_receipt: request.expectedReceipt };
  const source = { id: request.taskId, authority_kind: 'catsco', request_hash: request.requestHash,
    candidate_hash: request.candidateHash, candidate: Buffer.from(rawJson), candidate_bytes: String(Buffer.byteLength(rawJson)),
    intake_result: validation, validation_result: null, state: 'delegated_pending', commit_started: false,
    expires_at: new Date(Date.now() + 60000) };
  return { request, row, source, original, derived };
}
