import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationDescriptionReleaseWorker } from '../../packages/publication-description-derivations/worker.js';

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
