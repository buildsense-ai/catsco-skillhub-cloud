import path from "node:path";
import { generateId, publicManifest, sha256 } from "../domain/index.js";
import { artifactUrl, writeArtifactAtomic } from "../object-storage/index.js";
import { canonicalJson, ensureSigningKey, signPayload } from "../signing/index.js";

export async function buildPublishedPackage({
  config,
  submission,
  files,
  scanRun,
  reviewer,
  sourceVersion,
  releaseAt
}) {
  if (!sourceVersion?.commitSha || !sourceVersion?.treeSha || !sourceVersion?.tag) {
    throw new Error("Git source version is required before publishing");
  }
  const publishedAt = canonicalReleaseTime(releaseAt);
  const manifest = publicManifest(submission.normalizedManifest);
  const normalizedFiles = normalizePackageFiles(files, manifest);
  const contentHash = computeSkillContentHash(files);
  const sbom = {
    schemaVersion: "1.0.0",
    generatedAt: publishedAt,
    files: normalizedFiles.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
  };
  const review = {
    schemaVersion: "1.0.0",
    submissionId: submission.id,
    scanRunId: scanRun?.id ?? null,
    riskLevel: scanRun?.riskLevel ?? "low",
    approvedBy: reviewer?.id ?? "system",
    approvedAt: publishedAt
  };

  const payload = {
    packageSchemaVersion: "1.0.0",
    manifest,
    sourceVersion: {
      model: "git",
      repositoryId: sourceVersion.repositoryId,
      commitSha: sourceVersion.commitSha,
      treeSha: sourceVersion.treeSha,
      tag: sourceVersion.tag
    },
    review,
    sbom,
    files: normalizedFiles
  };

  const key = await ensureSigningKey(config);
  const signature = signPayload(payload, key, { signedAt: publishedAt });
  const unsignedSha256 = sha256(canonicalJson(payload));
  const packageObject = {
    payload,
    signature,
    checksum: {
      algorithm: "sha256",
      payloadSha256: unsignedSha256
    }
  };
  const packageBytes = Buffer.from(`${canonicalJson(packageObject)}\n`, "utf8");
  const packageSha256 = sha256(packageBytes);
  const artifact = await writeArtifactAtomic(config, packageBytes);

  return {
    id: generateId("pkg"),
    skillId: manifest.id,
    skillName: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    status: "published",
    packagePath: artifact.artifactPath,
    packageFile: artifact.artifactFile,
    packageUrl: artifactUrl(config, artifact.artifactSha256),
    packageSize: packageBytes.length,
    checksumSha256: packageSha256,
    payloadSha256: unsignedSha256,
    contentHash,
    signature,
    manifest,
    submissionId: submission.id,
    scanRunId: scanRun?.id ?? null,
    publishedAt,
    yankedAt: null,
    deprecatedAt: null,
    downloadCount: 0,
    storageBackend: "git-v1",
    gitRepositoryId: sourceVersion.repositoryId,
    gitCommitSha: sourceVersion.commitSha,
    gitTreeSha: sourceVersion.treeSha,
    gitTag: sourceVersion.tag,
    artifactSha256: artifact.artifactSha256
  };
}

function canonicalReleaseTime(value) {
  const parsed = new Date(value || Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error("Release timestamp is invalid");
  return parsed.toISOString();
}

export function computeSkillContentHash(files) {
  const entries = sourceFileEntries(files).map((file) => {
    const buffer = skillHashBuffer(file.path, file.buffer);
    return { path: file.path, size: buffer.length, sha256: sha256(buffer) };
  });
  return sha256(JSON.stringify(entries));
}

function skillHashBuffer(filePath, buffer) {
  if (filePath !== "SKILL.md") return buffer;
  return Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function normalizePackageFiles(files, manifest) {
  const byPath = new Map();
  for (const file of sourceFileEntries(files)) {
    const buffer = skillHashBuffer(file.path, file.buffer);
    byPath.set(file.path, {
      path: file.path,
      size: buffer.length,
      sha256: sha256(buffer),
      contentBase64: buffer.toString("base64")
    });
  }
  return [...byPath.values()].sort(compareFilePaths);
}

function sourceFileEntries(files) {
  return files
    .map((file) => ({ path: file.path, buffer: fileBuffer(file) }))
    .filter((file) => path.basename(file.path) !== "skill.json")
    .sort(compareFilePaths);
}

function compareFilePaths(left, right) {
  const a = typeof left === "string" ? left : left.path;
  const b = typeof right === "string" ? right : right.path;
  return a < b ? -1 : a > b ? 1 : 0;
}

function fileBuffer(file) {
  if (file.buffer) return file.buffer;
  if (file.contentBase64) return Buffer.from(file.contentBase64, "base64");
  return Buffer.from(String(file.content ?? ""), "utf8");
}
