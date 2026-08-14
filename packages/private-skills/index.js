import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256, validatePackagePath, ValidationError } from "../domain/index.js";
import { writeArtifactAtomic } from "../object-storage/index.js";
import {
  canonicalJson,
  loadSigningKeyCertificateByKeyId,
  verifyPayload
} from "../signing/index.js";

export const PRIVATE_SKILL_PACKAGE_SCHEMA = "catsco.private-skill-package.v1";
const PUBLIC_DOWNLOAD_MAX_FILES = 200;
const PUBLIC_DOWNLOAD_MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const PUBLIC_DOWNLOAD_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const PUBLIC_PACKAGE_MAX_BYTES = 30 * 1024 * 1024;

export function isPrivateSkillReference(skillId) {
  const value = String(skillId ?? "").trim().toLowerCase();
  return value.startsWith("priv_") || value.startsWith("private/");
}

export function parsePrivateSkillUpsert(body, config) {
  requirePlainObject(body, "Request body");
  rejectUnknownKeys(body, ["localSkillId", "name", "contentHash", "origin", "files"]);
  const localSkillId = requireText(body.localSkillId, "localSkillId", 160, /^[A-Za-z0-9._:-]+$/);
  const name = requireText(body.name, "name", 256);
  const contentHash = requireHash(body.contentHash, "contentHash");
  const origin = body.origin === undefined ? undefined : parseReference(body.origin, "origin");
  if (!Array.isArray(body.files) || body.files.length === 0) {
    throw validation("Skill package must contain files.", "PRIVATE_SKILL_FILES_REQUIRED");
  }
  if (body.files.length > config.privateSkills.maxFiles) {
    throw validation("Skill package contains too many files.", "PRIVATE_SKILL_TOO_MANY_FILES", 413);
  }

  const seen = new Set();
  let totalBytes = 0;
  const files = body.files.map((raw, index) => {
    requirePlainObject(raw, `files[${index}]`);
    rejectUnknownKeys(raw, ["path", "size", "sha256", "contentBase64"]);
    const packagePath = validatePortablePath(raw.path, {
      maxPathLength: 1024,
      maxPathDepth: 64
    });
    const portablePath = packagePath.toLocaleLowerCase("en-US");
    if (seen.has(portablePath)) {
      throw validation("Skill package contains duplicate file paths.", "PRIVATE_SKILL_DUPLICATE_PATH");
    }
    seen.add(portablePath);
    const size = Number(raw.size);
    if (!Number.isInteger(size) || size < 0 || size > config.privateSkills.maxSingleFileBytes) {
      throw validation("Skill package file size is invalid.", "PRIVATE_SKILL_FILE_TOO_LARGE", 413);
    }
    const fileHash = requireHash(raw.sha256, `files[${index}].sha256`);
    if (typeof raw.contentBase64 !== "string") {
      throw validation("Skill package file encoding is invalid.", "PRIVATE_SKILL_BASE64_INVALID");
    }
    const bytes = decodeBase64Exact(raw.contentBase64, size);
    totalBytes += bytes.length;
    if (totalBytes > config.privateSkills.maxTotalBytes) {
      throw validation("Skill package exceeds its total byte limit.", "PRIVATE_SKILL_TOO_LARGE", 413);
    }
    if (bytes.length !== size || sha256(bytes) !== fileHash) {
      throw validation("Skill package file checksum does not match.", "PRIVATE_SKILL_FILE_HASH_MISMATCH");
    }
    return {
      path: packagePath,
      size,
      sha256: fileHash,
      contentBase64: raw.contentBase64,
      buffer: bytes
    };
  }).sort(compareFilePaths);

  if (!files.some((file) => file.path === "SKILL.md")) {
    throw validation("Skill package is missing SKILL.md.", "PRIVATE_SKILL_ENTRY_MISSING");
  }
  const computedHash = computePrivateSkillContentHash(files);
  if (computedHash !== contentHash) {
      throw validation("Skill package content hash does not match.", "PRIVATE_SKILL_CONTENT_HASH_MISMATCH");
  }
  // Bot-scoped backups preserve the package bytes exactly. Content-risk
  // reporting belongs to the public publication scanner; this private sync
  // boundary only enforces package structure, size, encoding, and integrity.
  return { localSkillId, name, contentHash, origin, files, totalBytes };
}

export function privatePackageMetadata(packageValue) {
  return {
    reference: packageValue.reference,
    localSkillId: packageValue.localSkillId,
    name: packageValue.name,
    contentHash: packageValue.contentHash,
    createdAt: packageValue.createdAt,
    ...(packageValue.origin ? { origin: packageValue.origin } : {})
  };
}

export function buildPrivatePackage({ reservation, input, sourceVersion }) {
  return {
    schema: PRIVATE_SKILL_PACKAGE_SCHEMA,
    reference: {
      skillId: reservation.skillId,
      version: reservation.version
    },
    localSkillId: input.localSkillId,
    name: input.name,
    contentHash: input.contentHash,
    createdAt: reservation.createdAt,
    ...(sourceVersion ? {
      sourceVersion: {
        model: "git",
        repositoryId: sourceVersion.repositoryId,
        commitSha: sourceVersion.commitSha,
        treeSha: sourceVersion.treeSha,
        tag: sourceVersion.tag
      }
    } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    files: input.files.map(({ path: filePath, size, sha256: fileHash, contentBase64 }) => ({
      path: filePath,
      size,
      sha256: fileHash,
      contentBase64
    }))
  };
}

export async function writePrivatePackageAtomic(config, packageValue) {
  const bytes = Buffer.from(`${JSON.stringify(packageValue)}\n`, "utf8");
  const artifact = await writeArtifactAtomic(config, bytes, {
    privateArtifact: true,
    extension: ".json"
  });
  return {
    packagePath: artifact.artifactPath,
    packageSha256: artifact.artifactSha256,
    packageBytes: artifact.artifactBytes
  };
}

export async function readPrivatePackage(row, config) {
  const privateRoot = await fs.realpath(config.paths.private);
  const resolvedPackagePath = await fs.realpath(row.packagePath);
  if (
    resolvedPackagePath !== privateRoot
    && !resolvedPackagePath.startsWith(`${privateRoot}${path.sep}`)
  ) {
    throw validation("Stored private package path escaped its private root.", "PRIVATE_SKILL_STORED_PACKAGE_TAMPERED", 500);
  }
  const linkStat = await fs.lstat(row.packagePath);
  if (linkStat.isSymbolicLink()) {
    throw validation("Stored private package cannot be a symbolic link.", "PRIVATE_SKILL_STORED_PACKAGE_TAMPERED", 500);
  }
  const stat = await fs.stat(resolvedPackagePath);
  if (!stat.isFile() || stat.size > config.privateSkills.maxRequestBytes) {
    throw validation("Stored private package is invalid.", "PRIVATE_SKILL_STORED_PACKAGE_INVALID", 500);
  }
  const bytes = await fs.readFile(resolvedPackagePath);
  if (sha256(bytes) !== row.packageSha256) {
    throw validation("Stored private package failed integrity verification.", "PRIVATE_SKILL_STORED_PACKAGE_TAMPERED", 500);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw validation("Stored private package is unreadable.", "PRIVATE_SKILL_STORED_PACKAGE_INVALID", 500);
  }
  if (
    value?.schema !== PRIVATE_SKILL_PACKAGE_SCHEMA
    || value?.reference?.skillId !== row.skillId
    || value?.reference?.version !== row.version
    || value?.localSkillId !== row.localSkillId
    || value?.contentHash !== row.contentHash
  ) {
    throw validation("Stored private package metadata does not match its database row.", "PRIVATE_SKILL_STORED_PACKAGE_TAMPERED", 500);
  }
  // Re-run all structure, size, encoding, and integrity checks on read so disk
  // tampering cannot turn a previously accepted reference into different content.
  parsePrivateSkillUpsert({
    localSkillId: value.localSkillId,
    name: value.name,
    contentHash: value.contentHash,
    ...(value.origin ? { origin: value.origin } : {}),
    files: value.files
  }, config);
  return value;
}

export async function publicVersionAsDownloadedPackage(version, config) {
  const stat = await fs.stat(version.packagePath);
  if (!stat.isFile() || stat.size > PUBLIC_PACKAGE_MAX_BYTES) {
    throw validation("Published Skill package is too large for workspace restore.", "PUBLIC_SKILL_PACKAGE_TOO_LARGE", 413);
  }
  const bytes = await fs.readFile(version.packagePath);
  if (sha256(bytes) !== version.checksumSha256) {
    throw validation("Published Skill package failed integrity verification.", "PUBLIC_SKILL_PACKAGE_TAMPERED", 500);
  }
  let packageObject;
  try {
    packageObject = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw validation("Published Skill package is invalid.", "PUBLIC_SKILL_PACKAGE_INVALID", 500);
  }
  await verifyPublishedPackageTrust(packageObject, version, config);
  const rawFiles = packageObject?.payload?.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > PUBLIC_DOWNLOAD_MAX_FILES) {
    throw validation("Published Skill package file list is invalid.", "PUBLIC_SKILL_PACKAGE_INVALID", 500);
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = rawFiles.map((raw, index) => {
    requirePlainObject(raw, `payload.files[${index}]`);
    const filePath = validatePortablePath(raw.path, {
      maxPathLength: 180,
      maxPathDepth: 12
    });
    const portablePath = filePath.toLocaleLowerCase("en-US");
    if (seen.has(portablePath)) {
      throw validation("Published Skill package contains duplicate paths.", "PUBLIC_SKILL_PACKAGE_INVALID", 500);
    }
    seen.add(portablePath);
    const size = Number(raw.size);
    const fileHash = requireHash(raw.sha256, `payload.files[${index}].sha256`);
    if (!Number.isInteger(size) || size < 0 || size > PUBLIC_DOWNLOAD_MAX_SINGLE_FILE_BYTES) {
      throw validation("Published Skill package file size is invalid.", "PUBLIC_SKILL_PACKAGE_TOO_LARGE", 413);
    }
    if (typeof raw.contentBase64 !== "string") {
      throw validation("Published Skill package encoding is invalid.", "PUBLIC_SKILL_PACKAGE_INVALID", 500);
    }
    const fileBytes = decodeBase64Exact(raw.contentBase64, size);
    totalBytes += fileBytes.length;
    if (
      totalBytes > PUBLIC_DOWNLOAD_MAX_TOTAL_BYTES
      || fileBytes.length !== size
      || sha256(fileBytes) !== fileHash
    ) {
      throw validation("Published Skill package file integrity failed.", "PUBLIC_SKILL_PACKAGE_TAMPERED", 500);
    }
    const workspaceBytes = normalizeWorkspaceFileBytes(filePath, fileBytes);
    return {
      path: filePath,
      size: workspaceBytes.length,
      sha256: sha256(workspaceBytes),
      contentBase64: workspaceBytes.toString("base64")
    };
  }).sort(compareFilePaths);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw validation("Published Skill package is missing SKILL.md.", "PUBLIC_SKILL_PACKAGE_INVALID", 500);
  }
  const contentHash = computePrivateSkillContentHash(files);
  if (!/^[a-f0-9]{64}$/.test(String(version.contentHash || '')) || contentHash !== version.contentHash) {
    throw validation(
      "Published Skill package content hash does not match its registry row.",
      "PUBLIC_SKILL_PACKAGE_TAMPERED",
      500
    );
  }
  return {
    reference: {
      skillId: version.skillId,
      version: version.version
    },
    localSkillId: `public-${sha256(`${version.skillId}\0${version.version}`).slice(0, 32)}`,
    name: String(version.skillName || packageObject?.payload?.manifest?.name || "skill").slice(0, 256),
    contentHash,
    createdAt: version.publishedAt,
    files
  };
}

export function computePrivateSkillContentHash(files) {
  const entries = [...files]
    .map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    .sort(compareFilePaths);
  return sha256(JSON.stringify(entries));
}

function normalizeWorkspaceFileBytes(filePath, bytes) {
  if (filePath !== "SKILL.md") return bytes;
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

export function opaquePrivateReference(prefix, byteLength) {
  return `${prefix}_${crypto.randomBytes(byteLength).toString("hex")}`;
}

function compareFilePaths(left, right) {
  const a = typeof left === "string" ? left : left.path;
  const b = typeof right === "string" ? right : right.path;
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseReference(value, field) {
  requirePlainObject(value, field);
  rejectUnknownKeys(value, ["skillId", "version"]);
  return {
    skillId: requireReferenceText(value.skillId, `${field}.skillId`, 240),
    version: requireReferenceText(value.version, `${field}.version`, 120)
  };
}

function requireReferenceText(value, field, maxLength) {
  const text = requireText(value, field, maxLength);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw validation(`${field} contains control characters.`, "PRIVATE_SKILL_REFERENCE_INVALID");
  }
  return text;
}

function validatePortablePath(value, limits) {
  if (typeof value !== "string") {
    throw validation("Skill package path must be a string.", "PRIVATE_SKILL_PATH_INVALID");
  }
  const filePath = validatePackagePath(value, limits);
  for (const segment of filePath.split("/")) {
    if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) {
      throw validation("Skill package path is not portable.", "PRIVATE_SKILL_PATH_INVALID");
    }
    const stem = segment.split(".")[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw validation("Skill package path uses a reserved device name.", "PRIVATE_SKILL_PATH_INVALID");
    }
  }
  return filePath;
}

function decodeBase64Exact(value, declaredSize) {
  if (
    (value.length === 0 && declaredSize !== 0)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    || value.length % 4 !== 0
  ) {
    throw validation("Skill package Base64 is invalid.", "PRIVATE_SKILL_BASE64_INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw validation("Skill package Base64 is not canonical.", "PRIVATE_SKILL_BASE64_INVALID");
  }
  return bytes;
}

async function verifyPublishedPackageTrust(packageObject, version, config) {
  const payload = packageObject?.payload;
  const signature = packageObject?.signature;
  const payloadSha256 = packageObject?.checksum?.payloadSha256;
  if (
    !payload
    || signature?.algorithm !== "ed25519"
    || typeof signature?.keyId !== "string"
    || typeof signature?.signature !== "string"
    || payloadSha256 !== sha256(canonicalJson(payload))
    || payload?.manifest?.id !== version.skillId
    || payload?.manifest?.version !== version.version
  ) {
    throw validation("Published Skill package trust metadata is invalid.", "PUBLIC_SKILL_PACKAGE_UNTRUSTED", 500);
  }
  let certificate;
  try {
    certificate = await loadSigningKeyCertificateByKeyId(config, signature.keyId, {
      payload,
      signature
    });
  } catch {
    throw validation("Published Skill signing certificate is unavailable.", "PUBLIC_SKILL_PACKAGE_UNTRUSTED", 500);
  }
  if (
    certificate?.subject?.keyId !== signature.keyId
    || certificate?.subject?.algorithm !== "ed25519"
    || typeof certificate?.subject?.publicKeyPem !== "string"
    || !verifyPayload(payload, signature, certificate.subject.publicKeyPem)
  ) {
    throw validation("Published Skill package signature is invalid.", "PUBLIC_SKILL_PACKAGE_UNTRUSTED", 500);
  }
}

function requireHash(value, field) {
  const text = requireText(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw validation(`${field} must be a lowercase SHA-256 hash.`, "PRIVATE_SKILL_HASH_INVALID");
  }
  return text;
}

function requireText(value, field, maxLength, pattern) {
  if (typeof value !== "string") {
    throw validation(`${field} must be a string.`, "PRIVATE_SKILL_VALIDATION_ERROR");
  }
  const text = value.trim();
  if (!text || text.length > maxLength || (pattern && !pattern.test(text))) {
    throw validation(`${field} is invalid.`, "PRIVATE_SKILL_VALIDATION_ERROR");
  }
  return text;
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw validation(`${field} must be an object.`, "PRIVATE_SKILL_VALIDATION_ERROR");
  }
}

function rejectUnknownKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw validation("Request contains unknown fields.", "PRIVATE_SKILL_UNKNOWN_FIELD");
  }
}

function validation(message, code, status = 400) {
  return new ValidationError(message, code, status);
}
