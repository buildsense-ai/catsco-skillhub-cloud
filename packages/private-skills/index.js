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
const MAX_CREDENTIAL_ASSIGNMENTS = 512;
const MAX_CREDENTIAL_EXPRESSION_CHARS = 16 * 1024;
const EXPLICIT_SAFE_CREDENTIAL_VALUES = new Set([
  "catsco-bot-key",
  "catsco-fallback-user",
  "catsco-stale-bot-key",
  "catsco-user-login",
  "catsco-user-token",
  "reference-smoke-secret",
  "smoke-key",
  "smoke-secret"
]);
const CREDENTIAL_EXPRESSION_CONTINUATION_TOKENS = new Set([
  "\\", "||", "??", "&&", "=", "==", "===", "!=", "!==", "=>", "<=", ">=",
  "?", ":", "+", "-", "*", "/", "%", "&", "|", "^", "~", ".", "?.", "<", ">",
  "(", "[", "!", "as", "satisfies", "instanceof", "in"
]);
const PRIVATE_FORBIDDEN_DIRECTORIES = new Set([".ssh", ".aws", ".kube", ".gnupg"]);
const PRIVATE_FORBIDDEN_ARCHIVE_EXTENSIONS = [
  ".7z",
  ".bz2",
  ".gz",
  ".rar",
  ".tar",
  ".tar.bz2",
  ".tar.gz",
  ".tar.xz",
  ".tgz",
  ".txz",
  ".xz",
  ".zip",
  ".zst"
];

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
    rejectSensitiveMaterial(packagePath, bytes);
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
  // Bot-scoped backups keep their runtime capabilities. Public Registry policy
  // stays in the publication pipeline; the per-file checks above still reject
  // credentials, sensitive paths, archives, binaries, and tampered content.
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
  // Re-run all byte/path/hash/sensitive checks on read so disk tampering cannot
  // turn a previously accepted reference into different content.
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

function rejectSensitiveMaterial(filePath, bytes) {
  if (filePath.split("/").some((segment) => PRIVATE_FORBIDDEN_DIRECTORIES.has(segment.toLowerCase()))) {
    throw validation("Skill package contains a forbidden credential directory.", "PRIVATE_SKILL_SENSITIVE_REJECTED", 422);
  }
  const name = path.posix.basename(filePath).toLowerCase();
  if (
    name === ".env"
    || name.startsWith(".env.")
    || PRIVATE_FORBIDDEN_ARCHIVE_EXTENSIONS.some((extension) => name.endsWith(extension))
    || hasArchiveMagic(bytes)
    || [".npmrc", ".pypirc", "credentials", "credentials.json", "kubeconfig", "id_rsa", "id_ed25519"].includes(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
    || /\.(?:exe|dll|so|dylib|msi|apk|appimage)$/i.test(name)
    || containsHighConfidenceSecret(filePath, bytes)
  ) {
    throw validation("Skill package contains sensitive material.", "PRIVATE_SKILL_SENSITIVE_REJECTED", 422);
  }
}

function hasArchiveMagic(bytes) {
  return (
    startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
    || startsWithBytes(bytes, [0x1f, 0x8b])
    || startsWithBytes(bytes, [0x42, 0x5a, 0x68])
    || startsWithBytes(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
    || startsWithBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || startsWithBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])
    || startsWithBytes(bytes, [0x28, 0xb5, 0x2f, 0xfd])
    || (bytes.length >= 262 && bytes.subarray(257, 262).equals(Buffer.from("ustar", "ascii")))
  );
}

function startsWithBytes(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
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

function containsHighConfidenceSecret(filePath, bytes) {
  if (bytes.includes(0)) return false;
  const text = bytes.toString("utf8");
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) return true;
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(text)) return true;
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text)) return true;
  const sourceExtension = path.posix.extname(filePath).toLowerCase();
  const isSourceCode = [".cjs", ".js", ".jsx", ".mjs", ".py", ".ts", ".tsx"].includes(sourceExtension);
  const equalsAssignments = text.matchAll(new RegExp(
    /(?=(?:^|[^A-Za-z0-9_.'"`-])(?<quote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote>\]?(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:\|\|=|\?\?=|&&=|[?+]?=(?![=>]))(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s#,;}]+)))/im.source,
    "gimd"
  ));
  if (hasSensitiveCredentialAssignment(
    equalsAssignments,
    isSourceCode,
    text,
    "equals",
    sourceExtension
  )) return true;
  const colonAssignments = text.matchAll(new RegExp(
    /(?=(?:^[ \t]*|[\[,{](?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*)(?:-[ \t]+)?(?<quote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote>(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*:(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s#,;}]+)))/im.source,
    "gimd"
  ));
  if (hasSensitiveCredentialAssignment(
    colonAssignments,
    isSourceCode,
    text,
    "colon",
    sourceExtension
  )) return true;
  const commandAssignments = text.matchAll(
    /^(?:[ \t]*[Ss][Ee][Tt][Xx](?:[ \t]+\/[A-Za-z]+)*[ \t]+(?<quote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote>[ \t]+|[ \t]*ENV[ \t]+(?<quote2>["']?)(?<key2>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote2>[ \t]+)(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s#,;}]+))/gm
  );
  if (hasSensitiveCredentialAssignment(commandAssignments, isSourceCode)) return true;
  const quotedSetAssignments = text.matchAll(
    /^[ \t]*[Ss][Ee][Tt][ \t]+(?<outer>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*=[ \t]*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>[^"'\r\n]*?))(?:\k<outer>)?[ \t]*$/gm
  );
  return hasSensitiveCredentialAssignment(quotedSetAssignments, isSourceCode);
}

function hasSensitiveCredentialAssignment(
  assignments,
  isSourceCode,
  sourceText,
  boundary,
  sourceExtension = ""
) {
  let scannedAssignments = 0;
  for (const match of assignments) {
    const key = String(match.groups?.key || match.groups?.key2 || "")
      .replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase();
    if (!/(?:apikey|accesstoken|authtoken|clientsecret|secretaccesskey|secretkey|password|passwd|token|secret)$/.test(key)) {
      continue;
    }
    scannedAssignments += 1;
    if (scannedAssignments > MAX_CREDENTIAL_ASSIGNMENTS) return true;
    const candidate = String(
      match.groups?.double ?? match.groups?.single ?? match.groups?.bare ?? ""
    ).toLowerCase();
    const isBare = match.groups?.bare !== undefined;
    const expression = sourceText && boundary
      ? readCredentialExpression(sourceText, match, boundary, sourceExtension)
      : undefined;
    if (sourceText && boundary && !expression) return true;
    if (
      isBare
      && isSourceCode
      && expression
      && isSafeRuntimeCredentialExpression(expression.value.toLowerCase())
    ) {
      continue;
    }
    if (
      isSourceCode
      && expression
      && isSafeTypeOnlyCredentialDeclaration(expression.value.toLowerCase())
    ) {
      continue;
    }
    if (
      !isExplicitSafeCredentialValue(key, candidate, isBare, isSourceCode)
      || !isOnlyCredentialExpressionTrivia(expression?.tail || "")
    ) {
      return true;
    }
  }
  return false;
}

function readCredentialExpression(source, match, boundary, sourceExtension) {
  const indices = match.indices?.groups;
  const group = match.groups?.bare !== undefined
    ? "bare"
    : match.groups?.double !== undefined
      ? "double"
      : match.groups?.single !== undefined
        ? "single"
        : undefined;
  const range = group ? indices?.[group] : undefined;
  if (!group || !range) return undefined;
  const quoted = group !== "bare";
  const valueStart = Math.max(0, range[0] - (quoted ? 1 : 0));
  const tokenEnd = Math.min(source.length, range[1] + (quoted ? 1 : 0));
  const valueEnd = findCredentialExpressionEnd(
    source,
    valueStart,
    boundary,
    boundary === "colon" || sourceExtension !== ".py"
  );
  if (valueEnd === undefined || valueEnd < tokenEnd) return undefined;
  return {
    value: source.slice(valueStart, valueEnd).trim(),
    tail: source.slice(tokenEnd, valueEnd)
  };
}

function findCredentialExpressionEnd(source, start, boundary, stopAtComma) {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote = "";
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  let lastToken = "";

  for (let index = start; index < source.length; index += 1) {
    if (index - start > MAX_CREDENTIAL_EXPRESSION_CHARS) return undefined;
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char !== "\n" && char !== "\r") continue;
      lineComment = false;
      if (roundDepth || squareDepth || curlyDepth || expressionContinues(lastToken, source, index, start)) {
        continue;
      }
      return index;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
        lastToken = "literal";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") roundDepth += 1;
    else if (char === "[") squareDepth += 1;
    else if (char === "{") curlyDepth += 1;
    else if (char === ")" && roundDepth > 0) roundDepth -= 1;
    else if (char === "]" && squareDepth > 0) squareDepth -= 1;
    else if (char === "}" && curlyDepth > 0) curlyDepth -= 1;
    else if (!roundDepth && !squareDepth && !curlyDepth) {
      if (
        char === ";"
        || (stopAtComma && char === ",")
        || (boundary === "colon" && char === "}")
      ) return index;
      if (char === "\n" || char === "\r") {
        if (expressionContinues(lastToken, source, index, start)) continue;
        return index;
      }
    }
    if (/\s/.test(char)) continue;
    const token = readCredentialToken(source, index);
    lastToken = token.value;
    index = token.end - 1;
  }
  return source.length - start <= MAX_CREDENTIAL_EXPRESSION_CHARS
    ? source.length
    : undefined;
}

function expressionContinues(lastToken, source, lineEnd, expressionStart) {
  if (
    lastToken === "*"
    && /^\*{3,}$/.test(source.slice(expressionStart, lineEnd).trim())
  ) {
    return false;
  }
  if (isCredentialContinuationToken(lastToken)) return true;
  const nextToken = readNextCredentialToken(source, lineEnd + 1);
  return nextToken === "`" || isCredentialContinuationToken(nextToken);
}

function isCredentialContinuationToken(value) {
  return CREDENTIAL_EXPRESSION_CONTINUATION_TOKENS.has(value);
}

function readNextCredentialToken(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return "";
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return "";
      index = end + 2;
      continue;
    }
    return readCredentialToken(source, index).value;
  }
  return "";
}

function readCredentialToken(source, start) {
  const operator = /^(?:\|\||\?\?|&&|===|!==|==|!=|=>|<=|>=|\?\.|.)/.exec(source.slice(start));
  const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(start));
  const value = word?.[0] || operator?.[0] || source[start];
  return { value: value.toLowerCase(), end: start + value.length };
}

function isOnlyCredentialExpressionTrivia(value) {
  const withoutBlockComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  const trimmed = withoutBlockComments.trim();
  return trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#");
}

function isSafeEmptyEnvironmentLookup(candidate) {
  const identifier = "[a-z_$][a-z0-9_$]*";
  const accessor = `(?:\\??\\.${identifier}|\\[(?:${identifier}|\\d+|["'][a-z0-9_$.-]+["'])\\])`;
  const expressionPath = `${identifier}(?:${accessor})*`;
  const environmentKey = `(?:${expressionPath}|["'][a-z0-9_.-]+["'])`;
  return new RegExp(
    `^os\\.environ\\.get\\(${environmentKey},\\s*(?:""|'')\\)`
      + `(?:\\s+if\\s+${expressionPath}\\s+else\\s+(?:""|''))?$`
  ).test(candidate);
}

function isSafeRuntimeCredentialExpression(candidate, depth = 0, allowBareIdentifier = true) {
  if (depth > 4) return false;
  const normalized = candidate
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/[ \t]+(?:\/\/|#).*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:null|""|''|void 0)$/.test(normalized)) return true;
  if (
    (isRuntimeCredentialExpression(normalized) && (
      allowBareIdentifier || !/^[a-z_$][a-z0-9_$]*$/.test(normalized)
    ))
    || isSafeEmptyEnvironmentLookup(normalized)
  ) {
    return true;
  }
  const chain = normalized.split(/\s*(?:\|\||\?\?|&&)\s*/);
  if (chain.length > 1 && chain.every(part => (
    part && isSafeRuntimeCredentialExpression(part, depth + 1, false)
  ))) {
    return true;
  }
  const ternary = /^(.+?)(?<!\?)\?(?![?.])(.+?):(.+)$/.exec(normalized);
  if (
    ternary
    && isSafeRuntimeCredentialExpression(ternary[1], depth + 1, true)
    && ternary.slice(2).every(part => (
      isSafeRuntimeCredentialExpression(part, depth + 1, false)
    ))
  ) {
    return true;
  }
  const typeAssertion = /^(.+?)\s+as\s+[a-z_$][a-z0-9_$]*(?:\[\])?$/.exec(normalized);
  return Boolean(
    typeAssertion
    && isSafeRuntimeCredentialExpression(typeAssertion[1], depth + 1, allowBareIdentifier)
  );
}

function isSafeTypeOnlyCredentialDeclaration(candidate) {
  const type = "(?:string|number|boolean|unknown|null|undefined)";
  return new RegExp(`^${type}(?:\\s*\\|\\s*${type})+$`).test(candidate.trim());
}

function isExplicitSafeCredentialValue(key, candidate, isBare, isSourceCode) {
  return (
    candidate === ""
    || /^\$\{[a-z_][a-z0-9_]*\}$/.test(candidate)
    || /^%[a-z_][a-z0-9_]*%$/.test(candidate)
    || /^\$env:[a-z_][a-z0-9_]*$/.test(candidate)
    || (isBare && isSourceCode && isRuntimeCredentialExpression(candidate))
    || (
      /(?:password|passwd)$/.test(key)
      && /^(?:minimum|maximum)[-_]length[-_]\d+$/.test(candidate)
    )
    || /^(?:string|number|boolean|unknown|null|undefined|z\.string\(\)(?:\.min\(\d+\))?)$/.test(candidate)
    || /^(?:example[-_](?:api[-_]?key|token|secret|password)|placeholder(?:[-_]value)?|dummy[-_]value|changeme(?:[-_]please)?|your[-_](?:api[-_]?key|token|secret|password)[-_]here|\*{3,})$/.test(candidate)
    || (isSourceCode && EXPLICIT_SAFE_CREDENTIAL_VALUES.has(candidate))
  );
}

function isRuntimeCredentialExpression(candidate) {
  const identifier = "[a-z_$][a-z0-9_$]*";
  const accessor = `(?:\\??\\.${identifier}|\\[(?:${identifier}|\\d+|["'][a-z0-9_$.-]+["'])\\])`;
  const expressionPath = `${identifier}(?:${accessor})*`;
  const call = `\\((?:${expressionPath}|\\d+)?\\)`;
  return (
    new RegExp(`^${identifier}$`).test(candidate)
    || new RegExp(`^(?:${expressionPath}|${identifier})(?:(?:${accessor})|${call})+$`).test(candidate)
    || new RegExp(`^os\\.environ\\.get\\((?:${expressionPath}|["'][a-z0-9_.-]+["'])\\)$`).test(candidate)
  );
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
