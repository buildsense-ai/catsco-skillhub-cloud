import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { publicManifest } from '../domain/index.js';
import { normalizePackageFiles } from '../packager/files.js';
import { validateGitSourcePaths } from '../git-storage/source-paths.js';
import { decodeSource } from '../publish-validation/intake.js';
import { effectiveLimits, parseStrictJson, readEntryFrontmatter, RULE_VERSION,
  validatePublishRequest } from '../publish-validation/index.js';
import { runPublishValidation } from '../publish-validation/runner.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const serviceFields = ['skillhub_author', 'skillhub_version', 'skillhub_uploaded_at'];
// Bytewise ordering, independent of host locale. This is a material identity,
// NOT the legacy content deduplication hash (which omits metadata files).
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const failure = (code, message, status = 422) => ({ status, body: { error: {
  code: `skillhub.publication_prepare_${code}`, message
} } });

function checkedIdentity(identity, manifest) {
  if (!identity || !manifest || !['ownerId','uploadId','skillId','version','releaseAt'].every(k =>
    typeof identity[k] === 'string' && identity[k].length > 0 && identity[k].length <= 512) ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(identity.skillId) ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(identity.version) ||
    identity.version.length > 160 || identity.skillId !== manifest.id || identity.version !== manifest.version ||
    !Number.isFinite(Date.parse(identity.releaseAt)) || new Date(identity.releaseAt).toISOString() !== identity.releaseAt) {
    throw new Error('Invalid publication identity');
  }
  return Object.fromEntries(['ownerId','uploadId','skillId','version','releaseAt'].map(k => [k,identity[k]]));
}

function materialHash(manifest, files) {
  return digest(canonical({ domain: 'skillhub-final-material-v1', manifest,
    files: files.map(file => {
      const buffer = Buffer.from(file.contentBase64, 'base64');
      if (buffer.toString('base64') !== file.contentBase64 || buffer.length !== file.size || digest(buffer) !== file.sha256) {
        throw new Error('Invalid prepared file');
      }
      return { path: file.path, size: file.size, sha256: file.sha256 };
    }) }));
}

function runtimeMetadata(data) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !serviceFields.includes(key)));
}

// Private internal worker operation. `manifest` and `identity` must come from
// the future authorized/reserved publication intent, NEVER from an HTTP receipt.
// It neither reserves a version nor proves authority nor performs publication.
export function preparePublication(input, inputLimits = {}) {
  const limits = effectiveLimits(inputLimits);
  let raw, requestHash, identity, manifest;
  try {
    requestHash = digest(typeof input.rawJson === 'string' ? Buffer.from(input.rawJson) : input.rawJson);
    raw = typeof input.rawJson === 'string' ? input.rawJson
      : new TextDecoder('utf-8', { fatal: true }).decode(input.rawJson);
    manifest = publicManifest(input.manifest);
    identity = checkedIdentity(input.identity, manifest);
    if (!hashPattern.test(input.candidateHash ?? '') || !hashPattern.test(input.requestHash ?? '')) throw new Error('Missing candidate hashes');
  } catch { return failure('context_invalid', 'Publication preparation context is invalid.', 400); }

  if (requestHash !== input.requestHash) return failure('request_changed', 'The stored candidate bytes changed.', 409);

  const original = validatePublishRequest(raw, limits);
  if (original.status !== 200) return original;
  if (original.body.validation.candidateHash !== input.candidateHash) {
    return failure('candidate_changed', 'The validated candidate changed.', 409);
  }
  const body = parseStrictJson(raw, limits);
  const files = decodeSource(body, limits);
  const packaged = files.find(file => file.path === 'skill.json');
  const packagedManifest = packaged ? parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(packaged.buffer), limits) : {};
  const explicit = body.manifest ?? body.form ?? {};
  const originalEntry = explicit.entrypoints?.skillFile ?? explicit.skillFile ??
    packagedManifest.entrypoints?.skillFile ?? packagedManifest.skillFile ?? 'SKILL.md';
  const entry = manifest.entrypoints?.skillFile ?? manifest.skillFile ?? 'SKILL.md';
  if (entry !== originalEntry) return failure('entrypoint_changed', 'Publication cannot change the validated entrypoint.');
  // The legacy packager drops every basename skill.json. A nested manifest may
  // be used by a script: never silently remove it in this strict path.
  if (files.some(file => file.path.endsWith('/skill.json'))) {
    return failure('file_would_be_removed', 'Packaging would remove a nested skill.json; review the package manually.');
  }
  const before = readEntryFrontmatter(files.find(file => file.path === entry), limits);
  const skillHub = { author: identity.skillId.split('/')[0], version: identity.version, uploadedAt: identity.releaseAt };
  const fields = { skillhub_author: skillHub.author, skillhub_version: skillHub.version,
    skillhub_uploaded_at: skillHub.uploadedAt };
  manifest = { ...manifest, skillHub, ...fields };
  let header;
  if (before.format === 'json') header = JSON.stringify({ ...before.data, ...fields }, null, 2);
  else {
    // Already budget-validated YAML. Updating parsed top-level keys avoids the
    // old line filter corrupting block scalars, quoted keys or JSON headers.
    const doc = parseDocument(before.header, { version: '1.2', schema: 'core', uniqueKeys: true, strict: true });
    for (const [key, value] of Object.entries(fields)) doc.set(key, value);
    header = doc.toString().replace(/\n$/, '');
  }
  const entryBuffer = Buffer.from(`---${before.format === 'json' ? 'json' : ''}\n${header}\n---\n${before.body}`);
  const derived = files.map(file => file.path === entry ? { path: entry, buffer: entryBuffer } : file);
  const normalized = normalizePackageFiles(derived);
  // Git stores the normalized payload PLUS a generated root manifest. Check
  // exactly that path set, so case variants cannot collide only after 202.
  try { validateGitSourcePaths([...normalized.map(file => file.path), 'skill.json'], limits); }
  catch (error) {
    if (error.code === 'git.source_path_reserved') {
      return failure('path_reserved', 'Package paths cannot contain a .git segment (case-insensitive); remove Git metadata and retry.');
    }
    if (error.code === 'git.source_path_duplicate') {
      return failure('path_duplicate', 'Package paths must be unique ignoring case, including the generated root skill.json.');
    }
    if (error.code === 'git.source_path_collision') {
      return failure('path_collision', 'A final package path cannot be both a file and a directory, including the generated root skill.json.');
    }
    return failure('path_invalid', 'The final package contains a path that Git storage cannot accept.');
  }
  // Validate exactly the manifest + bytes the signer will consume, after ALL
  // packager filtering/newline transformations, not the pre-transformation input.
  const finalRaw = JSON.stringify({ manifest, source: { type: 'files', files: normalized.map(file =>
    ({ path: file.path, contentBase64: file.contentBase64 })) } });
  const final = validatePublishRequest(finalRaw, limits);
  if (final.status !== 200) return final;
  const afterFile = normalized.find(file => file.path === entry);
  const after = readEntryFrontmatter({ buffer: Buffer.from(afterFile.contentBase64, 'base64') }, limits);
  if (canonical(runtimeMetadata(before.data)) !== canonical(runtimeMetadata(after.data)) ||
    before.body.replace(/\r\n/g, '\n') !== after.body.replace(/\r\n/g, '\n')) {
    return failure('semantics_changed', 'Publication metadata changed runtime instructions; manual review is required.');
  }
  const receipt = {
    schemaVersion: '1', ruleVersion: RULE_VERSION, identity,
    requestHash, candidateHash: input.candidateHash,
    limitsFingerprint: original.body.validation.limitsFingerprint,
    finalCandidateHash: final.body.validation.candidateHash,
    materialHash: materialHash(manifest, normalized)
  };
  // Contains private file bodies. This result must never be sent as an API
  // task/report response. Only bounded validation reports are public.
  return { status: 200, body: { validation: final.body.validation },
    prepared: { manifest, files: normalized, receipt } };
}

export function assertPreparedPublication(receipt, material, inputLimits = {}) {
  try {
    const limits = effectiveLimits(inputLimits);
    const identity = checkedIdentity(material.identity, material.manifest);
    if (!receipt || receipt.schemaVersion !== '1' || receipt.ruleVersion !== RULE_VERSION ||
      !['candidateHash','requestHash','finalCandidateHash','materialHash','limitsFingerprint'].every(k => hashPattern.test(receipt[k] ?? '')) ||
      canonical(identity) !== canonical(receipt.identity) ||
      receipt.limitsFingerprint !== digest(canonical(limits)) ||
      receipt.materialHash !== materialHash(material.manifest, material.files)) throw new Error('Mismatch');
  } catch {
    throw Object.assign(new Error('Prepared publication no longer matches the material or publication identity.'),
      { status: 409, code: 'skillhub.publication_prepare_mismatch' });
  }
}

// Enforces the existing timeout/memory/abort budgets, and waits for termination
// before callers may release admission. Uploaded code is never executed.
export function runPreparePublication(input, limits, options = {}) {
  return runPublishValidation(input, limits, { ...options, workerUrl: new URL('./prepare-worker.js', import.meta.url) });
}
