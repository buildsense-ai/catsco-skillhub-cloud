import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runDerivePublicationDescription } from '../publication-tasks/description-derivation.js';
import { exactProposal, proposalDigest, PublicationDescriptionDerivationError } from './store.js';
import { delegatedValidationReport } from '../publication-delegation/validation-report.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const receiptHashes = ['originalRequestHash', 'originalCandidateHash', 'validationDigest',
  'proposalDigest', 'limitsFingerprint', 'derivedRequestHash', 'derivedCandidateHash'];
const fail = (kind, status = 409) => { throw new PublicationDescriptionDerivationError(kind, status); };

export function validDescriptionCopyRead(input) {
  const r = input?.expectedReceipt;
  return exact(input, ['schemaVersion', 'applicationId', 'taskId', 'requestHash', 'candidateHash',
    'proposal', 'expectedReceipt', 'derivedBytes']) && input.schemaVersion === 1
    && typeof input.applicationId === 'string' && /^pubdesc_[a-f0-9]{64}$/.test(input.applicationId)
    && typeof input.taskId === 'string' && /^pubtask_[0-9a-f-]{36}$/.test(input.taskId)
    && digest(input.requestHash) && digest(input.candidateHash) && exactProposal(input.proposal)
    && Number.isSafeInteger(input.derivedBytes) && input.derivedBytes > 0
    && exact(r, ['schemaVersion', 'algorithm', ...receiptHashes]) && r.schemaVersion === '1'
    && r.algorithm === 'skillhub-description-derivation-v1' && receiptHashes.every(key => digest(r[key]))
    && r.originalRequestHash === input.requestHash && r.originalCandidateHash === input.candidateHash
    && r.proposalDigest === proposalDigest(input.proposal)
    && r.derivedRequestHash !== r.originalRequestHash && r.derivedCandidateHash !== r.originalCandidateHash;
}

// Private byte recovery only, never an execution/publication grant. The trusted
// CatsCo caller must load the immutable application and recheck live authority,
// cancellation and Runtime source before AND after this network operation.
// There is no fallback to a new capture, derivation retention or model call.
export async function readPublicationDescriptionCopy(store, input, limits, options = {}) {
  return (await inspectPublicationDescriptionCopy(store, input, limits, options)).bytes;
}

// Report-only view of the same retained copy. No caller-supplied package/report
// is accepted, and no fresh publication task, copy or repair round is created.
// A fresh report ID is expected; the future CatsCo continuation must durably
// bind the accepted report at its own authority-checked state transition.
export async function validatePublicationDescriptionCopy(store, input, limits, options = {}) {
  const verified = await inspectPublicationDescriptionCopy(store, input, limits, options);
  const validation = delegatedValidationReport(verified.result, verified.input.expectedReceipt.derivedCandidateHash);
  if (validation.truncated || validation.limitsFingerprint !== verified.input.expectedReceipt.limitsFingerprint) fail('copy_changed');
  return { schemaVersion: 1, applicationId: verified.input.applicationId, taskId: verified.input.taskId,
    derivedBytes: verified.input.derivedBytes, receipt: verified.input.expectedReceipt, validation };
}

async function inspectPublicationDescriptionCopy(store, input, limits, options) {
  if (!validDescriptionCopyRead(input) || input.derivedBytes > limits.maxRequestBytes) fail('invalid', 400);
  input = structuredClone(input);
  const checkAbort = () => { if (options.signal?.aborted) fail('unavailable', 503); };
  checkAbort();
  const row = await store.getPublicationDescriptionDerivation(input.applicationId);
  checkAbort();
  if (!row) fail('copy_unavailable');
  if (row.application_id !== input.applicationId || row.task_id !== input.taskId
    || row.request_hash !== input.requestHash || row.candidate_hash !== input.candidateHash
    || !isDeepStrictEqual(row.proposal, input.proposal) || row.proposal_digest !== input.expectedReceipt.proposalDigest
    || row.derived_request_hash !== input.expectedReceipt.derivedRequestHash
    || row.derived_candidate_hash !== input.expectedReceipt.derivedCandidateHash
    || !isDeepStrictEqual(row.derivation_receipt, input.expectedReceipt)
    || Number(row.derived_bytes) !== input.derivedBytes) fail('conflict');
  if (!Buffer.isBuffer(row.derived_raw_json) || row.derived_raw_json.length !== input.derivedBytes
    || sha(row.derived_raw_json) !== input.expectedReceipt.derivedRequestHash) fail('copy_changed');
  const bytes = Buffer.from(row.derived_raw_json);
  const readSource = async () => {
    const source = await store.getPublicationDescriptionDerivationSource(input.taskId);
    checkAbort();
    const expiry = new Date(source?.expires_at).getTime();
    if (!source || source.id !== input.taskId || source.authority_kind !== 'catsco'
      || source.request_hash !== input.requestHash || source.candidate_hash !== input.candidateHash
      || source.state !== 'delegated_pending' || source.commit_started !== false
      || !Number.isFinite(expiry) || expiry <= Date.now()
      || !Buffer.isBuffer(source.candidate) || source.candidate.length < 1
      || source.candidate.length > limits.maxRequestBytes || Number(source.candidate_bytes) !== source.candidate.length
      || sha(source.candidate) !== input.requestHash) fail('source_unavailable');
    return source;
  };
  const source = await readSource();
  const validation = source.validation_result ?? source.intake_result;
  const original = { rawJson: Buffer.from(source.candidate), requestHash: input.requestHash,
    candidateHash: input.candidateHash, validation: validation?.body?.validation ?? validation?.body?.error?.validation,
    proposal: input.proposal };
  // Bounded worker rederivation proves ALL retained bytes, not just a
  // self-consistent hash on a substituted package. Never execute package code.
  const rechecked = await runDerivePublicationDescription(original, limits, options);
  checkAbort();
  if (rechecked.status !== 200 || !isDeepStrictEqual(rechecked.derived.receipt, input.expectedReceipt)
    || !Buffer.from(rechecked.derived.rawJson).equals(bytes)) fail('copy_changed');
  await readSource();
  return { bytes, input, result: rechecked };
}
