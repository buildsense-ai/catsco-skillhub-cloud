import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../packages/config/index.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { createPublicationDescriptionReleaseWorker } from '../../packages/publication-description-derivations/worker.js';

const sha = value => createHash('sha256').update(value).digest('hex');

test('derived release worker is default-off and does not touch storage', async () => {
  let touched = false;
  const worker = createPublicationDescriptionReleaseWorker({ enabled: false, config: {}, store: {
    query: async () => { touched = true; }, tx: async () => { touched = true; }
  } });
  assert.equal(await worker.once(), null);
  assert.equal(touched, false);
});

test('derived release worker refuses incomplete configuration', async () => {
  const worker = createPublicationDescriptionReleaseWorker({ enabled: true, config: {}, store: {
    query: async () => ({ rows: [] }), tx: async fn => fn({ query: async () => ({ rows: [] }) })
  } });
  await assert.rejects(worker.once(), { code: 'skillhub.publication_description_derivation_release_commit_configuration' });
});

test('derived release worker carries retained bytes across the commit-table claim', async () => {
  const rawJson = JSON.stringify({ source: { type: 'files', files: [
    { path: 'SKILL.md', content: '---\nname: sample\ndescription: Useful\n---\nPrivate instructions.\n' }
  ] } });
  const checked = validatePublishRequest(rawJson);
  const rawBytes = Buffer.from(rawJson);
  const identity = { ownerId: 'owner-1', uploadId: 'upload-1', skillId: 'alice/sample',
    version: '1.0.0', releaseAt: '2026-10-26T00:00:00.000Z' };
  const manifest = { id: identity.skillId, name: 'sample', displayName: 'Sample',
    description: 'Useful', version: identity.version,
    entrypoints: { skillFile: 'SKILL.md' }, runtime: { platforms: ['windows'] } };
  const applicationId = `pubdesc_${'a'.repeat(64)}`;
  const commitRow = { application_id: applicationId, task_id: 'task-1', permit_id: 'permit-1',
    target: { candidateHash: checked.body.validation.candidateHash }, manifest, identity, state: 'publishing' };
  const completeRow = { ...commitRow, state: 'committing' };
  let claim;
  const store = {
    query: async () => ({ rows: [] }),
    tx: async fn => fn({ query: async (sql) => {
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('SELECT c.application_id')) return { rows: [{ ...commitRow,
        state: 'queued', attempts: 0, lease_token: null, lease_until: null,
        derived_raw_json: rawBytes, derived_request_hash: sha(rawBytes),
        derived_candidate_hash: checked.body.validation.candidateHash }] };
      if (sql.includes("SET state='committing'")) return { rows: [completeRow] };
      if (sql.includes('UPDATE publication_description_release_commits') && sql.includes("state='publishing'")) {
        claim = true;
        return { rows: [commitRow] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    } })
  };
  const config = loadConfig({ nodeEnv: 'test', publicationTasksEnabled: true });
  const worker = createPublicationDescriptionReleaseWorker({ enabled: true, config, store });
  const completed = await worker.once();
  assert.equal(claim, true);
  assert.equal(completed.state, 'committing');
});
