import { sha256, ValidationError } from "../domain/index.js";
import { parsePrivateSkillUpsert } from "../private-skills/index.js";

const MAX_ID = 256;

export function parsePrivateSkillMutation(body, config) {
  requirePlainObject(body, "Mutation request");
  rejectUnknownKeys(body, [
    "mutationId",
    "grantId",
    "botUid",
    "localSkillId",
    "name",
    "actorUserUid",
    "sourceTopicId",
    "sourceMessageId",
    "runtimeBodyId",
    "clientRequestId",
    "operation",
    "candidateContentHash",
    "candidateSizeBytes",
    "expectedPreviousHash",
    "beforeReference",
    "files"
  ]);

  const mutationId = positiveInteger(body.mutationId, "mutationId");
  const grantId = boundedText(body.grantId, "grantId", MAX_ID);
  const botUid = boundedText(body.botUid, "botUid", 160);
  const localSkillId = boundedText(body.localSkillId, "localSkillId", 160, /^[A-Za-z0-9._:-]+$/);
  const name = boundedText(body.name ?? localSkillId, "name", 256);
  const actorUserUid = positiveInteger(body.actorUserUid, "actorUserUid");
  const sourceTopicId = boundedText(body.sourceTopicId, "sourceTopicId", 255);
  const sourceMessageId = positiveInteger(body.sourceMessageId, "sourceMessageId");
  const runtimeBodyId = boundedText(body.runtimeBodyId, "runtimeBodyId", 160);
  const clientRequestId = boundedText(body.clientRequestId, "clientRequestId", 160);
  const operation = String(body.operation ?? "").trim().toLowerCase();
  if (!['create', 'replace'].includes(operation)) {
    throw validation("Mutation operation is unsupported.", "MUTATION_OPERATION_UNSUPPORTED");
  }
  const candidateContentHash = boundedHash(body.candidateContentHash, "candidateContentHash");
  const candidateSizeBytes = positiveInteger(body.candidateSizeBytes, "candidateSizeBytes");
  const expectedPreviousHash = body.expectedPreviousHash == null
    ? ""
    : boundedHash(body.expectedPreviousHash, "expectedPreviousHash");
  const beforeReference = body.beforeReference == null
    ? null
    : parseBeforeReference(body.beforeReference, expectedPreviousHash);

  if (operation === "create" && (expectedPreviousHash || beforeReference)) {
    throw validation("Create mutation cannot include a previous version.", "MUTATION_PREVIOUS_VERSION_INVALID");
  }
  if (operation === "replace" && (!expectedPreviousHash || !beforeReference)) {
    throw validation("Replace mutation requires the previous version.", "MUTATION_PREVIOUS_VERSION_REQUIRED");
  }

  const input = parsePrivateSkillUpsert({
    localSkillId,
    name,
    contentHash: candidateContentHash,
    files: body.files
  }, config);
  if (input.totalBytes !== candidateSizeBytes) {
    throw validation("Mutation candidate size does not match its files.", "MUTATION_SIZE_MISMATCH");
  }

  const normalized = {
    mutationId,
    grantId,
    botUid,
    localSkillId,
    name,
    actorUserUid,
    sourceTopicId,
    sourceMessageId,
    runtimeBodyId,
    clientRequestId,
    operation,
    candidateContentHash,
    candidateSizeBytes,
    expectedPreviousHash,
    beforeReference,
    input
  };
  return {
    ...normalized,
    requestFingerprint: sha256(JSON.stringify(fingerprintPayload(normalized)))
  };
}

export function mutationVersionReference({ localSkillId, version, contentHash }) {
  return {
    source: "skillhub",
    skillId: localSkillId,
    version,
    contentHash
  };
}

function fingerprintPayload(value) {
  return {
    mutationId: value.mutationId,
    grantId: value.grantId,
    botUid: value.botUid,
    localSkillId: value.localSkillId,
    name: value.name,
    actorUserUid: value.actorUserUid,
    sourceTopicId: value.sourceTopicId,
    sourceMessageId: value.sourceMessageId,
    runtimeBodyId: value.runtimeBodyId,
    clientRequestId: value.clientRequestId,
    operation: value.operation,
    candidateContentHash: value.candidateContentHash,
    candidateSizeBytes: value.candidateSizeBytes,
    expectedPreviousHash: value.expectedPreviousHash,
    beforeReference: value.beforeReference,
    files: value.input.files.map(({ path, size, sha256: fileHash }) => ({ path, size, sha256: fileHash }))
  };
}

function parseBeforeReference(value, expectedPreviousHash) {
  requirePlainObject(value, "beforeReference");
  rejectUnknownKeys(value, ["source", "skillId", "version", "contentHash"]);
  const reference = {
    source: boundedText(value.source, "beforeReference.source", 32).toLowerCase(),
    skillId: boundedText(value.skillId, "beforeReference.skillId", 255),
    version: boundedText(value.version, "beforeReference.version", 128),
    contentHash: boundedHash(value.contentHash, "beforeReference.contentHash")
  };
  if (reference.source !== "skillhub" || reference.contentHash !== expectedPreviousHash) {
    throw validation("Mutation previous reference is invalid.", "MUTATION_PREVIOUS_VERSION_INVALID");
  }
  return reference;
}

function positiveInteger(value, field) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw validation(`${field} must be a positive integer.`, "MUTATION_REQUEST_INVALID");
  }
  return number;
}

function boundedHash(value, field) {
  const text = boundedText(value, field, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw validation(`${field} must be a SHA-256 hash.`, "MUTATION_HASH_INVALID");
  }
  return text;
}

function boundedText(value, field, max, pattern = null) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text) || (pattern && !pattern.test(text))) {
    throw validation(`${field} is invalid.`, "MUTATION_REQUEST_INVALID");
  }
  return text;
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validation(`${field} must be an object.`, "MUTATION_REQUEST_INVALID");
  }
}

function rejectUnknownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw validation(`Unknown mutation field: ${key}.`, "MUTATION_REQUEST_INVALID");
  }
}

function validation(message, code) {
  return new ValidationError(message, code, 400);
}
