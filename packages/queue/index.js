import { createStore } from "../database/store.js";
import { generateId, nowIso } from "../domain/index.js";
import { commitGitVersion } from "../git-storage/index.js";
import { readSubmissionFiles } from "../object-storage/index.js";
import { buildPublishedPackage, computeSkillContentHash } from "../packager/index.js";
import { scanSkillPackage } from "../scanner/index.js";

export async function processNextJob(config, handlers = {}) {
  const store = createStore(config);
  const job = await store.claimNextJob(config.worker.id);
  if (!job) return null;

  try {
    if (handlers[job.type]) {
      await handlers[job.type](job, { config, store });
    } else if (job.type === "publish_skill_version") {
      await handlePublishSkillVersion(job, { config, store });
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }
    await store.completeJob(job.id);
    return { job, status: "succeeded" };
  } catch (error) {
    await store.failJob(job.id, error);
    return { job, status: "failed", error };
  }
}

export async function processJobs(config, { once = false } = {}) {
  const results = [];
  while (true) {
    const result = await processNextJob(config);
    if (!result) break;
    results.push(result);
    if (once) break;
  }
  return results;
}

async function handlePublishSkillVersion(job, { config, store }) {
  const { uploadId, manifest, publisher } = job.payload;
  if (!uploadId || !manifest?.id) throw new Error("Invalid publish_skill_version payload");
  const releaseAt = job.payload.releaseAt || job.createdAt || nowIso();

  await store.adoptPublicVersion({ uploadId, skillId: manifest.id,
    ownerId: publisher?.userId || publisher?.id, version: manifest.version });
  // A retry after DB commit must not rebuild/resign an already committed
  // release or revive a subsequently yanked version.
  const committed = await store.findPackageBySkillVersion(manifest.id, manifest.version);
  if (committed) {
    if (committed.submissionId !== uploadId) throw new Error('Publication version belongs to another upload');
    return;
  }
  if (config.publicationPublishing?.enabled) throw new Error('Legacy publication is paused: validated publication tasks are required.');

  const files = await readSubmissionFiles(config, uploadId);
  const report = scanSkillPackage({ files, manifest, config });
  const scanRun = {
    id: generateId("scan"),
    skillId: manifest.id,
    version: manifest.version,
    uploadId,
    status: report.status,
    riskLevel: report.riskLevel,
    summary: report.summary,
    findings: report.findings,
    inventory: report.inventory,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    scannerVersion: "0.1.0"
  };
  await store.saveSkillScan(scanRun);

  const contentHash = computeSkillContentHash(files);
  const existing = await store.findPackageBySkillContentHash(manifest.id, contentHash);
  if (existing) return;

  const submission = {
    id: uploadId,
    submitterId: publisher?.userId || publisher?.id,
    normalizedManifest: manifest
  };
  const sourceVersion = await commitGitVersion({
    config,
    scope: "public",
    skillId: manifest.id,
    version: manifest.version,
    files,
    createdAt: releaseAt,
    metadata: {
      uploadId,
      contentHash,
      publisherId: submission.submitterId,
      scanRunId: scanRun.id
    }
  });
  const packageVersion = await buildPublishedPackage({
    config,
    submission,
    files,
    scanRun,
    reviewer: publisher || { id: "skillhub", role: "system" },
    sourceVersion,
    releaseAt
  });
  packageVersion.riskLevel = scanRun.riskLevel;
  packageVersion.scanSummary = scanRun.summary;
  packageVersion.findings = scanRun.findings;
  await store.createPackageVersion(packageVersion, submission);
}
