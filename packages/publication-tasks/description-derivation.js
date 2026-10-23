import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { delegatedValidationReport } from '../publication-delegation/validation-report.js';
import { decodeSource } from '../publish-validation/intake.js';
import { effectiveLimits, parseStrictJson, readEntryFrontmatter, RULE_VERSION,
  validatePublishRequest } from '../publish-validation/index.js';
import { runPublishValidation } from '../publish-validation/runner.js';

const algorithm = 'skillhub-description-derivation-v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = (domain, value) => sha(`${domain}\0${canonical(value)}`);
const failure = (code, status = 409) => ({ status, body: { error: {
  code: `skillhub.publication_description_${code}`,
  message: 'Description candidate could not be derived; recheck the retained report and exact proposal.'
} } });
const comparableReport = report => Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'reportId'));
const withoutDescription = data => Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'description'));

function checkedProposal(proposal) {
  // Only the currently implemented validator selector is supported. In
  // particular, a model path, a nested entrypoint or skill.json cannot select
  // another file, even when it contains similarly named metadata.
  return exact(proposal, ['relativePath', 'field', 'entryIndex', 'text'])
    && proposal.relativePath === 'SKILL.md' && proposal.field === 'description'
    && Number.isSafeInteger(proposal.entryIndex) && proposal.entryIndex >= 0
    && typeof proposal.text === 'string' && proposal.text.isWellFormed()
    && proposal.text.trim().length > 0 && Buffer.byteLength(proposal.text) <= 8192
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(proposal.text);
}

function targetIssue(issue, proposal) {
  return issue.blocking && issue.code === 'metadata.description_missing' && issue.category === 'format'
    && issue.repairPolicy === 'confirmation_required'
    && exact(issue.location, ['relativePath', 'field', 'entryIndex'])
    && issue.location.relativePath === proposal.relativePath && issue.location.field === proposal.field
    && issue.location.entryIndex === proposal.entryIndex;
}

// Pure PRIVATE derivation, NOT an authorization, confirmation or publication
// API. It has no production caller, HTTP/RPC/model tool, filesystem/database,
// model call, task transition or budget mutation. The future trusted caller
// must load the exact confirmed draft/receipt from CatsCo, check current actor,
// cancellation, round and live Runtime source, then persist this independent
// output under that application identity. Digests and proposals are not grants.
export function derivePublicationDescription(input, inputLimits = {}) {
  const limits = effectiveLimits(inputLimits);
  let rawJson, report;
  if (!exact(input, ['rawJson', 'requestHash', 'candidateHash', 'validation', 'proposal'])
    || !hash(input.requestHash) || !hash(input.candidateHash) || !checkedProposal(input.proposal)) {
    return failure('context_invalid', 400);
  }
  try {
    const bytes = typeof input.rawJson === 'string' ? Buffer.from(input.rawJson) : input.rawJson;
    if (!(bytes instanceof Uint8Array) || bytes.length > limits.maxRequestBytes) return failure('context_invalid', 400);
    if (sha(bytes) !== input.requestHash) return failure('request_changed');
    rawJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    report = delegatedValidationReport({ status: 422, body: { error: { validation: input.validation } } }, input.candidateHash);
  } catch { return failure('context_invalid', 400); }

  if (report.ruleVersion !== RULE_VERSION || report.truncated) return failure('report_changed');
  if (!report.issues.some(issue => targetIssue(issue, input.proposal))
    || report.issues.some(issue => issue.category === 'package_safety' || (issue.blocking && !targetIssue(issue, input.proposal)))) {
    return failure('manual_review_required', 422);
  }

  // Revalidate the exact frozen input. A fresh report ID is expected, but no
  // rule, limit, message, issue, selector or coverage drift may pass silently.
  const original = validatePublishRequest(rawJson, limits);
  let rechecked;
  try { rechecked = delegatedValidationReport(original, input.candidateHash); }
  catch { return failure('candidate_changed'); }
  if (original.status !== 422 || !isDeepStrictEqual(comparableReport(report), comparableReport(rechecked))) {
    return failure('report_changed');
  }

  try {
    const body = parseStrictJson(rawJson, limits);
    const files = decodeSource(body, limits);
    const selected = files[input.proposal.entryIndex];
    if (!selected || selected.path !== 'SKILL.md') return failure('selector_changed');
    const before = readEntryFrontmatter(selected, limits);
    if (!(before.data.description === undefined || before.data.description === null
      || (typeof before.data.description === 'string' && !before.data.description.trim()))) {
      return failure('description_not_missing');
    }
    let header;
    if (before.format === 'json') header = JSON.stringify({ ...before.data, description: input.proposal.text }, null, 2);
    else {
      // The shared bounded parser has already rejected duplicate keys, custom
      // tags, aliases/cycles and budget overflow before this AST is composed.
      const doc = parseDocument(before.header, { version: '1.2', schema: 'core', uniqueKeys: true, strict: true });
      doc.set('description', input.proposal.text);
      header = doc.toString().replace(/\n$/, '');
    }
    const { start, end } = before.headerRange;
    const entryBytes = Buffer.concat([selected.buffer.subarray(0, start), Buffer.from(header), selected.buffer.subarray(end)]);
    const after = readEntryFrontmatter({ buffer: entryBytes }, limits);
    if (after.data.description !== input.proposal.text
      || !isDeepStrictEqual(withoutDescription(before.data), withoutDescription(after.data))
      || before.body !== after.body) return failure('semantics_changed', 422);

    // Never normalize or package here: every non-selected file remains exact,
    // including binaries, nested metadata, whitespace, file order and paths.
    const nextFiles = files.map((file, index) => ({ path: file.path,
      contentBase64: (index === input.proposal.entryIndex ? entryBytes : file.buffer).toString('base64') }));
    const nextRaw = JSON.stringify({ ...body, source: { type: 'files', files: nextFiles } });
    const result = validatePublishRequest(nextRaw, limits);
    if (result.status !== 200) return failure('derived_invalid', result.status);
    const derivedHash = result.body.validation.candidateHash;
    if (!hash(derivedHash) || derivedHash === input.candidateHash) return failure('no_progress');
    const receipt = {
      schemaVersion: '1', algorithm,
      originalRequestHash: input.requestHash, originalCandidateHash: input.candidateHash,
      validationDigest: digest(`${algorithm}:validation`, report),
      proposalDigest: digest(`${algorithm}:proposal`, input.proposal),
      limitsFingerprint: report.limitsFingerprint,
      derivedRequestHash: sha(nextRaw), derivedCandidateHash: derivedHash
    };
    // Private bytes must NOT be projected into public task/report responses.
    // The only fresh/random part is result.body.validation.reportId; the bytes,
    // hashes and derivation receipt are deterministic for replay/recovery.
    return { status: 200, body: result.body, derived: { rawJson: nextRaw, receipt } };
  } catch { return failure('derivation_unavailable', 503); }
}

// Re-derive before consuming a persisted copy. Even a correctly rehashed
// alternative package cannot substitute for this exact retained input/proposal.
// This checks integrity only: current authority must still be checked by caller.
export function assertPublicationDescriptionDerivation(receipt, candidate, input, limits = {}) {
  const expected = derivePublicationDescription(input, limits);
  if (expected.status !== 200 || !isDeepStrictEqual(receipt, expected.derived.receipt)
    || typeof candidate !== 'string' || candidate !== expected.derived.rawJson) {
    throw Object.assign(new Error('Description derivation no longer matches the retained input and proposal.'),
      { status: 409, code: 'skillhub.publication_description_mismatch' });
  }
}

// Use the existing bounded worker runner, including abort/timeout termination
// before releasing admission. Never execute uploaded scripts or metadata.
export function runDerivePublicationDescription(input, limits, options = {}) {
  return runPublishValidation(input, limits, { ...options,
    workerUrl: new URL('./description-derivation-worker.js', import.meta.url) });
}
