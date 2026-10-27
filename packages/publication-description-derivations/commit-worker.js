import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../signing/index.js';
import { validPublicationCommitTarget } from '../publication-delegation/commit-permit-client.js';
import { commitGitVersion, assertGitVersion } from '../git-storage/index.js';
import { buildPublishedPackage } from '../packager/index.js';
import { runPublishValidation } from '../publish-validation/runner.js';
import { runPreparePublication } from '../publication-tasks/prepare.js';
import { publicationTaskSettings } from '../publication-tasks/config.js';
import { createPublicationDescriptionReleaseCommitStore } from './commit-store.js';

const bytesHash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);

function error(code, status = 409) {
  const value = new Error('Description release completion could not be completed.');
  value.code = `skillhub.publication_description_release_commit_${code}`;
  value.status = status;
  return value;
}

function validationError(prepared) {
  return error(prepared.status >= 500 ? 'unavailable' : 'copy_changed', prepared.status >= 500 ? 503 : 409);
}

function validateTask(task) {
  if (!Buffer.isBuffer(task.derived_raw_json)
    || bytesHash(task.derived_raw_json) !== task.derived_request_hash
    || task.target?.candidateHash !== task.derived_candidate_hash
    || !validPublicationCommitTarget(task.target)
    || !task.receipt || !task.manifest || !task.identity) throw error('copy_changed');
}

function checkpointArtifact(config, checkpoint, manifest, files) {
  const packageVersion = checkpoint?.packageVersion;
  if (!packageVersion || packageVersion.artifactSha256 !== packageVersion.checksumSha256
    || !/^[a-f0-9]{64}$/.test(packageVersion.artifactSha256)) throw error('conflict');
  const artifactPath = path.join(config.paths.artifacts, packageVersion.artifactSha256.slice(0, 2),
    `${packageVersion.artifactSha256}.skillpkg`);
  if (path.resolve(packageVersion.packagePath) !== path.resolve(artifactPath)) throw error('artifact_changed');
  return fs.stat(artifactPath).then(async stat => {
    if (stat.size !== packageVersion.packageSize) throw error('artifact_changed');
    const bytes = await fs.readFile(artifactPath);
    if (bytesHash(bytes) !== packageVersion.checksumSha256) throw error('artifact_changed');
    let artifact;
    try { artifact = JSON.parse(bytes.toString('utf8')); } catch { throw error('artifact_changed'); }
    if (!equal(artifact?.payload?.manifest, manifest) || !equal(artifact?.payload?.files, files)) {
      throw error('artifact_changed');
    }
    return packageVersion;
  });
}

// Completes only the isolated description-derived lane. It does not call the
// legacy commit worker, create a public job, or write publication_commits.
export function createPublicationDescriptionReleaseCommitWorker({
  enabled = false, config, store, dependencies = {}
} = {}) {
  if (enabled !== true || !config || !store?.tx || !store?.query) return Object.freeze({
    async once() { return null; }
  });
  let settings;
  try { settings = publicationTaskSettings(config); } catch {
    return Object.freeze({ async once() { throw error('configuration', 503); } });
  }
  if (!settings || config.publicationPublishing?.enabled !== true) return Object.freeze({
    async once() { throw error('configuration', 503); }
  });
  const releaseStore = dependencies.releaseStore ?? createPublicationDescriptionReleaseCommitStore(store);
  const gitCommit = dependencies.commitGitVersion ?? commitGitVersion;
  const gitAssert = dependencies.assertGitVersion ?? assertGitVersion;
  const packageBuilder = dependencies.buildPublishedPackage ?? buildPublishedPackage;
  const scan = dependencies.runPublishValidation ?? runPublishValidation;
  const prepare = dependencies.runPreparePublication ?? runPreparePublication;
  let active = false;

  return Object.freeze({
    async once({ signal } = {}) {
      if (active || signal?.aborted) return null;
      active = true;
      let task;
      try { task = await releaseStore.claim(settings); }
      catch (caught) { active = false; throw caught; }
      if (!task) { active = false; return null; }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(abort, settings.commitTimeoutMs);
      let alive = true;
      let pending = null;
      const heartbeat = setInterval(() => {
        if (pending) return;
        pending = releaseStore.renew(task, settings).then(ok => {
          if (!ok) { alive = false; controller.abort(); }
        }, () => { alive = false; controller.abort(); }).finally(() => { pending = null; });
      }, Math.max(100, Math.floor(settings.leaseMs / 3)));
      const fence = () => {
        if (!alive) throw error('lease_lost');
        if (controller.signal.aborted) throw error('unavailable', 503);
      };
      try {
        validateTask(task);
        const prepared = await prepare({ rawJson: task.derived_raw_json,
          requestHash: task.derived_request_hash, candidateHash: task.derived_candidate_hash,
          manifest: task.manifest, identity: task.identity }, settings.limits, {
          timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb,
          signal: controller.signal
        });
        if (prepared.status !== 200 || !equal(prepared.prepared.manifest, task.manifest)
          || !equal(prepared.prepared.receipt, task.receipt)) throw validationError(prepared);
        fence();
        const { manifest, files, receipt } = prepared.prepared;
        let checkpoint = task.checkpoint;
        let sourceVersion;
        const gitFiles = [...files, { path: 'skill.json', content: `${canonicalJson(manifest)}\n` }];
        if (!checkpoint) {
          sourceVersion = await gitCommit({ config, scope: 'public', skillId: task.identity.skillId,
            version: task.identity.version, files: gitFiles, createdAt: task.identity.releaseAt,
            metadata: { uploadId: task.identity.uploadId, materialHash: receipt.materialHash }, signal: controller.signal });
          await gitAssert({ config, scope: 'public', skillId: task.identity.skillId, ...sourceVersion, signal: controller.signal });
          fence();
          const scanned = await scan({ files: gitFiles, manifest }, config.limits, {
            workerUrl: new URL('../publication-tasks/scan-worker.js', import.meta.url),
            timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb,
            signal: controller.signal
          });
          if (scanned.status !== 200) throw error('unavailable', 503);
          const report = scanned.report;
          const scanRun = { id: `scan_${randomUUID()}`, skillId: task.identity.skillId,
            version: task.identity.version, uploadId: task.identity.uploadId, ...report,
            scannerVersion: '0.1.0', startedAt: task.identity.releaseAt, finishedAt: task.identity.releaseAt };
          const packageVersion = await packageBuilder({ config,
            submission: { id: task.identity.uploadId, submitterId: task.identity.ownerId, normalizedManifest: manifest },
            files, scanRun, reviewer: { id: task.identity.ownerId }, sourceVersion,
            releaseAt: task.identity.releaseAt, preparedPublication: receipt });
          Object.assign(packageVersion, { riskLevel: scanRun.riskLevel, scanSummary: scanRun.summary,
            findings: scanRun.findings });
          await checkpointArtifact(config, { packageVersion }, manifest, files);
          fence();
          checkpoint = await releaseStore.saveCheckpoint(task, { packageVersion, scanRun });
        } else {
          await checkpointArtifact(config, checkpoint, manifest, files);
          sourceVersion = { repositoryId: checkpoint.packageVersion.gitRepositoryId,
            commitSha: checkpoint.packageVersion.gitCommitSha, treeSha: checkpoint.packageVersion.gitTreeSha,
            tag: checkpoint.packageVersion.gitTag };
          await gitAssert({ config, scope: 'public', skillId: task.identity.skillId, ...sourceVersion, signal: controller.signal });
        }
        fence();
        const completed = await releaseStore.complete(task, {
          packageVersion: checkpoint.packageVersion, scanRun: checkpoint.scanRun, manifest, identity: task.identity
        });
        return completed;
      } catch (caught) {
        const terminal = ['publisher_changed', 'copy_changed', 'conflict', 'artifact_changed', 'invalid']
          .some(kind => caught.code === `skillhub.publication_description_release_commit_${kind}`);
        const code = typeof caught.code === 'string' && caught.code.startsWith('skillhub.publication_description_release_commit_')
          ? caught.code : 'skillhub.publication_description_release_commit_unavailable';
        await releaseStore.fail(task, code, !terminal)
          .catch(() => false);
        return null;
      } finally {
        clearTimeout(deadline);
        clearInterval(heartbeat);
        signal?.removeEventListener('abort', abort);
        if (pending) await pending;
        active = false;
      }
    }
  });
}

export { checkpointArtifact, validateTask };
