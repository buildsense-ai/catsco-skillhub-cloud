import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../packages/config/index.js';
import { canonicalJson } from '../../packages/signing/index.js';
import { createPublicationDescriptionReleaseCommitWorker } from '../../packages/publication-description-derivations/commit-worker.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => sha(canonicalJson(value));

function fixture(root) {
  const candidate = Buffer.from('retained-derived-copy');
  const manifest = { id: 'alice/sample', name: 'sample', displayName: 'Sample', description: 'Useful',
    version: '1.0.0', entrypoints: { skillFile: 'SKILL.md' }, runtime: { platforms: ['windows'] } };
  const identity = { ownerId: 'owner-1', uploadId: 'upl_test', skillId: manifest.id, version: manifest.version,
    releaseAt: '2026-10-26T00:00:00.000Z' };
  const derivedCandidateHash = 'a'.repeat(64), requestHash = sha(candidate);
  const target = { candidateHash: derivedCandidateHash, manifestHash: canonicalHash(manifest), publisherUserId: identity.ownerId,
    publisherProfileId: 'profile-1', namespace: 'alice', skillId: manifest.id, version: identity.version,
    uploadId: identity.uploadId, releaseAt: identity.releaseAt, confirmVersionPublish: false };
  const receipt = { candidateHash: derivedCandidateHash, requestHash, identity, materialHash: 'b'.repeat(64) };
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('# Sample').toString('base64'),
    size: 8, sha256: sha(Buffer.from('# Sample')) }];
  const artifactPath = path.join(root, 'aa', `${'c'.repeat(64)}.skillpkg`);
  const packageVersion = { id: 'pkg_test', skillId: manifest.id, skillName: manifest.name, displayName: manifest.displayName,
    version: manifest.version, status: 'published', packagePath: artifactPath, packageFile: 'sample.skillpkg',
    packageUrl: 'https://skillhub.invalid/packages/test', packageSize: 0, checksumSha256: 'c'.repeat(64),
    payloadSha256: 'd'.repeat(64), contentHash: 'e'.repeat(64), signature: {}, manifest, submissionId: identity.uploadId,
    scanRunId: 'scan_test', riskLevel: 'low', scanSummary: {}, findings: [], publishedAt: identity.releaseAt,
    storageBackend: 'git-v1', gitRepositoryId: 'git_' + 'f'.repeat(32), gitCommitSha: '1'.repeat(40),
    gitTreeSha: '2'.repeat(40), gitTag: 'v1.0.0', artifactSha256: 'c'.repeat(64) };
  return { candidate, manifest, identity, derivedCandidateHash, requestHash, target, receipt, files, artifactPath, packageVersion };
}

test('derived completion worker is default-off and does not touch storage', async () => {
  let touched = false;
  const worker = createPublicationDescriptionReleaseCommitWorker({ enabled: false, config: {}, store: {
    query: async () => { touched = true; }, tx: async () => { touched = true; }
  } });
  assert.equal(await worker.once(), null);
  assert.equal(touched, false);
});
test('derived completion worker does not wedge after a claim storage error', async () => {
  let claims = 0;
  const config = loadConfig({ nodeEnv: 'test', publicationTasksEnabled: true, publicationPublishingEnabled: true });
  const worker = createPublicationDescriptionReleaseCommitWorker({ enabled: true, config,
    store: { query: async () => ({ rows: [] }), tx: async fn => fn({ query: async () => ({ rows: [] }) }) },
    dependencies: { releaseStore: { async claim() { claims++; if (claims === 1) throw new Error('db down'); return null; } } }
  });
  await assert.rejects(worker.once(), /db down/);
  assert.equal(await worker.once(), null);
  assert.equal(claims, 2);
});

test('derived completion worker validates the retained receipt and completes only its isolated store', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillhub-derived-completion-'));
  try {
    const f = fixture(root);
    const artifact = { payload: { manifest: f.manifest, files: f.files } };
    const bytes = Buffer.from(JSON.stringify(artifact));
    f.packageVersion.packageSize = bytes.length;
    f.packageVersion.checksumSha256 = sha(bytes);
    f.packageVersion.artifactSha256 = f.packageVersion.checksumSha256;
    f.artifactPath = path.join(root, 'blobs', 'sha256', f.packageVersion.checksumSha256.slice(0, 2), `${f.packageVersion.checksumSha256}.skillpkg`);
    f.packageVersion.packagePath = f.artifactPath;
    await fs.mkdir(path.dirname(f.artifactPath), { recursive: true });
    await fs.writeFile(f.artifactPath, bytes);
    const task = { application_id: 'pubdesc_' + '1'.repeat(64), task_id: 'pubtask_00000000-0000-4000-8000-000000000001',
      permit_id: 'pubdescpermit_' + '2'.repeat(32), target: f.target, manifest: f.manifest, identity: f.identity,
      state: 'committing', attempts: 1, lease_token: 'lease', lease_until: new Date(Date.now() + 30000),
      receipt: f.receipt, checkpoint: null, derived_raw_json: f.candidate, derived_request_hash: f.requestHash,
      derived_candidate_hash: f.derivedCandidateHash };
    const calls = [];
    const releaseStore = {
      async claim() { calls.push('claim'); return task; },
      async renew() { calls.push('renew'); return true; },
      async saveCheckpoint(_task, checkpoint) { calls.push('checkpoint'); task.checkpoint = checkpoint; return checkpoint; },
      async complete(_task, input) { calls.push('complete'); return { state: 'published', publication_result: { packageId: input.packageVersion.id } }; },
      async fail() { calls.push('fail'); }
    };
    const config = loadConfig({ nodeEnv: 'test', root, storageRoot: root, publicationTasksEnabled: true,
      publicationPublishingEnabled: true });
    const worker = createPublicationDescriptionReleaseCommitWorker({ enabled: true, config,
      store: { query: async () => ({ rows: [] }), tx: async fn => fn({ query: async () => ({ rows: [] }) }) },
      dependencies: {
        releaseStore,
        runPreparePublication: async () => ({ status: 200, prepared: { manifest: f.manifest, files: f.files, receipt: f.receipt } }),
        commitGitVersion: async () => ({ repositoryId: f.packageVersion.gitRepositoryId, commitSha: f.packageVersion.gitCommitSha,
          treeSha: f.packageVersion.gitTreeSha, tag: f.packageVersion.gitTag }),
        assertGitVersion: async () => ({}),
        runPublishValidation: async () => ({ status: 200, report: { status: 'clean', riskLevel: 'low', summary: {}, findings: [], inventory: [] } }),
        buildPublishedPackage: async () => ({ ...f.packageVersion })
      }
    });
    const result = await worker.once();
    assert.deepEqual(result, { state: 'published', publication_result: { packageId: 'pkg_test' } });
    assert.deepEqual(calls, ['claim', 'checkpoint', 'complete']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
