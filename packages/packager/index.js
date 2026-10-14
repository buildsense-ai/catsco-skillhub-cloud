import { generateId, publicManifest, sha256 } from "../domain/index.js";
import { computeSkillContentHash, normalizePackageFiles } from './files.js';
import { assertPreparedPublication } from '../publication-tasks/prepare.js';
export { computeSkillContentHash } from './files.js';
import { artifactUrl, writeArtifactAtomic } from "../object-storage/index.js";
import { canonicalJson, ensureSigningKey, signPayload } from "../signing/index.js";

export async function buildPublishedPackage({
  config,
  submission,
  files,
  scanRun,
  reviewer,
  sourceVersion,
  releaseAt,
  preparedPublication
}) {
  if (!sourceVersion?.commitSha || !sourceVersion?.treeSha || !sourceVersion?.tag) {
    throw new Error("Git source version is required before publishing");
  }
  const publishedAt = canonicalReleaseTime(releaseAt);
  const manifest = publicManifest(submission.normalizedManifest);
  const normalizedFiles = normalizePackageFiles(files);
  if (preparedPublication !== undefined) {
    assertPreparedPublication(preparedPublication, { manifest, files: normalizedFiles,
      identity: { ownerId: submission.submitterId, uploadId: submission.id,
        skillId: manifest.id, version: manifest.version, releaseAt: publishedAt } },
    { ...config.limits, ...config.publishValidation?.limits });
  }
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
