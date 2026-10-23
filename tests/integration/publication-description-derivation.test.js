import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { derivePublicationDescription, runDerivePublicationDescription,
  assertPublicationDescriptionDerivation } from '../../packages/publication-tasks/description-derivation.js';
import { validatePublishRequest, parseStrictJson, readEntryFrontmatter, effectiveLimits } from '../../packages/publish-validation/index.js';
import { decodeSource } from '../../packages/publish-validation/intake.js';
import { publicationSource } from '../helpers/publication-paths.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const instruction = 'Private runtime instructions\r\n```yaml\r\ndescription: do not edit body\r\n```\r\n';
const text = `---\nname: sample\n---\n${instruction}`;
const proposed = '  读取石墨文档。\nWhen the user provides a document URL, extract its text.\n  ';
const binary = Buffer.from([0, 255, 128, 10, 13, 0]);
function input(files = [{ path: 'SKILL.md', content: text }], { format = 'files', extra = {}, limits = {} } = {}) {
  const rawJson = JSON.stringify({ ...extra, source: publicationSource(files, format) });
  const validation = validatePublishRequest(rawJson, limits);
  const report = validation.body.validation ?? validation.body.error?.validation;
  return { rawJson, requestHash: sha(rawJson), candidateHash: report?.candidateHash ?? 'a'.repeat(64),
    validation: report, proposal: { relativePath: 'SKILL.md', field: 'description',
      entryIndex: files.findIndex(file => file.path === 'SKILL.md'), text: proposed } };
}
function derivedFiles(result) { return decodeSource(parseStrictJson(result.derived.rawJson)); }
function requireFailure(value, code, status) {
  assert.notEqual(value.status, 200);
  assert.equal(value.derived, undefined);
  if (code) assert.equal(value.body.error.code, `skillhub.publication_description_${code}`);
  if (status) assert.equal(value.status, status);
  assert.equal(JSON.stringify(value).includes('Private runtime instructions'), false);
}

test('derives only independent candidate bytes with exact proposal and immutable input', async () => {
  const original = input([{ path: 'assets/private.bin', contentBase64: binary.toString('base64') },
    { path: 'SKILL.md', content: text }, { path: 'scripts/run.js', content: 'throw Error("NEVER EXECUTE");\r\n' },
    { path: 'nested/skill.json', content: '{"keep":"exact whitespace"}  \n' }],
  { extra: { form: { id: 'alice/sample', version: '1.0.1', custom: { value: 1 } } } });
  const frozen = structuredClone(original);
  const result = await runDerivePublicationDescription(original);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(original, frozen);
  const beforeFiles = decodeSource(parseStrictJson(original.rawJson));
  const nextFiles = derivedFiles(result);
  assert.deepEqual(nextFiles.map(file => file.path), beforeFiles.map(file => file.path));
  for (let i = 0; i < nextFiles.length; i++) if (i !== original.proposal.entryIndex) {
    assert.deepEqual(nextFiles[i].buffer, beforeFiles[i].buffer);
  }
  assert.deepEqual(parseStrictJson(result.derived.rawJson).form, parseStrictJson(original.rawJson).form);
  const entry = readEntryFrontmatter(nextFiles[original.proposal.entryIndex]);
  assert.equal(entry.data.description, proposed);
  assert.equal(entry.body, instruction);
  assert.equal(result.body.validation.outcome, 'passed');
  assert.equal(result.body.validation.candidateHash, result.derived.receipt.derivedCandidateHash);
  assert.equal(sha(result.derived.rawJson), result.derived.receipt.derivedRequestHash);
  assert.notEqual(result.derived.receipt.originalCandidateHash, result.derived.receipt.derivedCandidateHash);
  assert.equal(result.derived.receipt.originalRequestHash, original.requestHash);
  assert.equal(result.derived.receipt.originalCandidateHash, original.candidateHash);
  assert.equal(JSON.stringify(result.body).includes('Private runtime instructions'), false);
  const repeated = derivePublicationDescription(original);
  assert.deepEqual(repeated.derived, result.derived);
  assert.notEqual(repeated.body.validation.reportId, result.body.validation.reportId);
  assertPublicationDescriptionDerivation(result.derived.receipt, result.derived.rawJson, original);
  assert.deepEqual(original, frozen);
});

for (const [name, header, marker] of [
  ['absent', 'name: sample', ''],
  ['null', 'name: sample\ndescription: null', ''],
  ['blank', 'name: sample\ndescription: " \t "', ''],
  ['flow YAML', '{name: sample, description: null, extra: {nested: [true, 1, null]}}', 'yaml'],
  ['JSON', '{"name":"sample","description":null,"extra":{"nested":[true,1,null]}}', 'json'],
  ['implicit JSON', '{"name":"sample","extra":{"__proto__":{"keep":"data"}}}', ''],
  ['quoted key', 'name: sample\n"description": null\n"__proto__": {keep: data}', ''],
  ['block scalars', 'name: sample\ncustom: |+\n  description: do not change\n\n  trailing blank\n\n', ''],
  ['nested fields', 'name: sample\ncustom:\n  description: keep this\n  skillhub_version: 0.0.1', '']
]) test(`shared parser preserves all non-description metadata for ${name}`, () => {
  const original = input([{ path: 'SKILL.md', content: `---${marker}\n${header}\n---\n${instruction}` }]);
  const before = readEntryFrontmatter(decodeSource(parseStrictJson(original.rawJson))[0]);
  const result = derivePublicationDescription(original);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const after = readEntryFrontmatter(derivedFiles(result)[0]);
  const omit = data => Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'description'));
  assert.deepEqual(omit(after.data), omit(before.data));
  assert.equal(after.data.description, proposed);
  assert.equal(after.body, before.body);
  assert.equal(Object.prototype.keep, undefined);
});

for (const prefix of ['', '\uFEFF', '\uFEFF\uFEFF']) {
  for (const eol of ['\n', '\r\n']) test(`header byte ranges preserve BOMs=${prefix.length}, ${JSON.stringify(eol)} and exact suffix`, () => {
    const content = `${prefix}---yaml  ${eol}name: sample${eol}description: null${eol}---${eol}${instruction}`;
    const original = input([{ path: 'SKILL.md', content }]);
    const beforeFile = decodeSource(parseStrictJson(original.rawJson))[0];
    const before = readEntryFrontmatter(beforeFile);
    assert.equal(beforeFile.buffer.subarray(before.headerRange.start, before.headerRange.end).toString(), before.header);
    const result = derivePublicationDescription(original);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const next = derivedFiles(result)[0], after = readEntryFrontmatter(next);
    assert.deepEqual(next.buffer.subarray(0, after.headerRange.start), beforeFile.buffer.subarray(0, before.headerRange.start));
    assert.deepEqual(next.buffer.subarray(after.headerRange.end), beforeFile.buffer.subarray(before.headerRange.end));
    assert.equal(after.body, instruction);
  });
}

test('ordinary ZIP and files requests derive the same package, never modify the archive', async () => {
  const files = [{ path: 'notes.txt', content: 'exact\r\n' }, { path: 'SKILL.md', content: text }];
  const flat = input(files), zipped = input(files, { format: 'zip' });
  const result = await runDerivePublicationDescription({ ...zipped, rawJson: Buffer.from(zipped.rawJson) });
  const expected = derivePublicationDescription(flat);
  assert.equal(result.status, 200);
  assert.equal(result.derived.rawJson, expected.derived.rawJson);
  assert.equal(result.derived.receipt.originalCandidateHash, expected.derived.receipt.originalCandidateHash);
  assert.notEqual(result.derived.receipt.originalRequestHash, expected.derived.receipt.originalRequestHash);
  assert.equal(result.derived.receipt.derivedCandidateHash, expected.derived.receipt.derivedCandidateHash);
});

test('proposal bytes are exact, including punctuation, quotes, delimiters and YAML-looking text', () => {
  for (const description of ['Has "quotes": # and [lists]', '---\nname: forged\n---\n', 'a\r\nb\rc\td\n',
    'Use __proto__, constructor, !custom &anchor *alias literally', '中'.repeat(2730) + 'ab']) {
    const original = input(); original.proposal.text = description;
    const result = derivePublicationDescription(original);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(readEntryFrontmatter(derivedFiles(result)[0]).data.description, description);
  }
});

test('invalid context, selectors, extra fields and proposal text are rejected without candidate bytes', () => {
  const original = input();
  for (const bad of [null, {}, { ...original, confirmed: true }, { ...original, requestHash: 'A'.repeat(64) },
    { ...original, rawJson: Buffer.from([0xff]), requestHash: sha(Buffer.from([0xff])) }]) {
    requireFailure(derivePublicationDescription(bad), 'context_invalid', 400);
  }
  for (const patch of [{ text: '' }, { text: ' \n\t' }, { text: 'a'.repeat(8193) }, { text: '\ud800' },
    { text: 'a\0b' }, { text: 'a\x7fb' }, { entryIndex: -1 }, { entryIndex: 0.5 }, { entryIndex: 2 ** 53 },
    { entryIndex: undefined }, { field: 'name' }, { relativePath: '../SKILL.md' }, { relativePath: 'skill.json' },
    { relativePath: 'nested/SKILL.md' }, { newField: 'ignored?' }]) {
    requireFailure(derivePublicationDescription({ ...original, proposal: { ...original.proposal, ...patch } }), 'context_invalid', 400);
  }
});

test('hash, retained report, rule, limits, selector and issue changes cannot authorize another candidate', () => {
  const original = input();
  requireFailure(derivePublicationDescription({ ...original, rawJson: original.rawJson + ' ' }), 'request_changed');
  const altered = original.rawJson.replace('Private runtime instructions', 'changed');
  requireFailure(derivePublicationDescription({ ...original, rawJson: altered, requestHash: sha(altered) }), 'candidate_changed');
  for (const patch of [{ ruleVersion: 'skillhub-publish-v0.0.1' }, { truncated: true }, { limitsFingerprint: 'f'.repeat(64) }]) {
    requireFailure(derivePublicationDescription({ ...original, validation: { ...original.validation, ...patch } }), 'report_changed');
  }
  const alteredMessage = structuredClone(original);
  alteredMessage.validation.issues[0].message = 'Different retained report';
  requireFailure(derivePublicationDescription(alteredMessage), 'report_changed');
  const wrongIndex = structuredClone(original);
  wrongIndex.validation.issues[0].location.entryIndex = 1;
  wrongIndex.proposal.entryIndex = 1;
  requireFailure(derivePublicationDescription(wrongIndex), 'report_changed');
  requireFailure(derivePublicationDescription({ ...original, proposal: { ...original.proposal, entryIndex: 1 } }), 'manual_review_required');
  requireFailure(derivePublicationDescription(original, { maxFiles: 499 }), 'report_changed');
});

test('manual, identity, compatibility and unsafe-package issues stop derivation', () => {
  const original = input();
  for (const issue of [
    { code: 'metadata.name_invalid', category: 'format', blocking: true, repairPolicy: 'manual' },
    { code: 'path.target_invalid', category: 'compatibility', blocking: true, repairPolicy: 'manual' },
    { code: 'path.unsafe', category: 'package_safety', blocking: false, repairPolicy: 'none' }
  ]) {
    const validation = structuredClone(original.validation);
    validation.issues.push({ ...issue, location: {}, message: 'Manual review needed' });
    requireFailure(derivePublicationDescription({ ...original, validation }), 'manual_review_required', 422);
  }
  for (const entry of ['---\ndescription: null\n---\nBody',
    '---\nname: sample\ndescription: 123\n---\nBody',
    '---\nname: sample\nname: duplicate\n---\nBody',
    '---\nname: sample\ncustom: !unsafe payload\n---\nBody',
    '---\nname: sample\ncustom: &loop [*loop]\n---\nBody']) {
    requireFailure(derivePublicationDescription(input([{ path: 'SKILL.md', content: entry }])));
  }
  for (const other of [{ path: '../secret', content: 'secret' }, { path: 'SKILL.md', content: 'duplicate' },
    { path: 'CON', content: 'incompatible' }, { path: 'skill.json', content: '{"id":"x","id":"y"}' }]) {
    requireFailure(derivePublicationDescription(input([{ path: 'SKILL.md', content: text }, other])));
  }
});

test('valid descriptions, arbitrary entrypoints, partial or passed reports cannot be repaired', () => {
  const alreadyValid = input([{ path: 'SKILL.md', content: text.replace('name: sample', 'name: sample\ndescription: useful') }]);
  requireFailure(derivePublicationDescription(alreadyValid), 'context_invalid');
  const custom = input([{ path: 'nested/SKILL.md', content: text }],
    { extra: { manifest: { entrypoints: { skillFile: 'nested/SKILL.md' } } } });
  custom.proposal.entryIndex = 0;
  requireFailure(derivePublicationDescription(custom), 'manual_review_required');
  const original = input();
  for (const patch of [{ coverage: 'partial' }, { extra: 'ignored?' }, { candidateHash: 'f'.repeat(64) },
    { issues: [] }, { outcome: 'passed' }]) {
    requireFailure(derivePublicationDescription({ ...original, validation: { ...original.validation, ...patch } }));
  }
});

test('growth in file, expanded request and parser budgets never yields a derived candidate', () => {
  for (const limits of [{ maxSingleFileBytes: 180 }, { maxExpandedBytes: 180 }, { maxRequestBytes: 250 }]) {
    const original = input(undefined, { limits }); original.proposal.text = 'a'.repeat(200);
    requireFailure(derivePublicationDescription(original, limits), 'derived_invalid', 413);
  }
  const limits = effectiveLimits({ maxNodes: 25 });
  const original = input(undefined, { limits });
  // Converting textual content to Base64 must still obey the request parser budget.
  const result = derivePublicationDescription(original, limits);
  assert.equal(result.status, 200, JSON.stringify(result.body));
});

test('persisted receipts reject rehashing, wrong proposals, report replacement and original-byte substitution', () => {
  const original = input(), result = derivePublicationDescription(original), { receipt, rawJson } = result.derived;
  for (const key of Object.keys(receipt)) {
    assert.throws(() => assertPublicationDescriptionDerivation({ ...receipt, [key]: 'changed' }, rawJson, original), { status: 409 });
  }
  for (const [candidate, context] of [
    [original.rawJson, original], [rawJson + ' ', original],
    [rawJson, { ...original, proposal: { ...original.proposal, text: 'Different confirmed text' } }],
    [rawJson, { ...original, validation: { ...original.validation, reportId: '12345678-1234-4234-8234-123456789012' } }]
  ]) assert.throws(() => assertPublicationDescriptionDerivation(receipt, candidate, context), { code: 'skillhub.publication_description_mismatch' });
  const changedBody = parseStrictJson(rawJson);
  changedBody.source.files[0].contentBase64 = Buffer.from('Different independent bytes').toString('base64');
  const changed = JSON.stringify(changedBody);
  assert.throws(() => assertPublicationDescriptionDerivation({ ...receipt, derivedRequestHash: sha(changed) }, changed, original), { status: 409 });
  assert.throws(() => assertPublicationDescriptionDerivation(receipt, rawJson, original, { maxFiles: 499 }), { status: 409 });
});

test('worker cancellation/timeout returns no private partial data and next invocation is independent', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runDerivePublicationDescription(input(), undefined, { signal: controller.signal }), { status: 503 });
  await assert.rejects(runDerivePublicationDescription(input(), undefined, { timeoutMs: 1 }), { status: 503 });
  requireFailure(await runDerivePublicationDescription(null), 'context_invalid');
  const first = await runDerivePublicationDescription(input());
  assert.equal(first.status, 200);
});
