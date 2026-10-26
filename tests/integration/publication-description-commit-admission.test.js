import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationDescriptionCommitAdmission, validRequest } from '../../packages/publication-description-derivations/commit-admission.js';

const request = { schemaVersion: 1, applicationId: `pubdesc_${'a'.repeat(64)}`, permitId: `pubdescpermit_${'b'.repeat(32)}` };

test('derived commit admission is default-off and validates its narrow request', async () => {
  assert.equal(validRequest(request), true);
  assert.equal(validRequest({ ...request, permitId: `pubpermit_${'b'.repeat(32)}` }), false);
  const admission = createPublicationDescriptionCommitAdmission({ enabled: false, store: {} });
  await assert.rejects(admission.admit(request), { code: 'skillhub.publication_description_release_commit_disabled' });
});

test('derived commit admission never accepts an arbitrary target or permit', async () => {
  let called = false;
  const admission = createPublicationDescriptionCommitAdmission({ enabled: true, store: {
    query: async () => { called = true; return { rows: [] }; },
    tx: async fn => fn({ query: async () => ({ rows: [] }) })
  } });
  await assert.rejects(admission.admit(request), { code: 'skillhub.publication_description_release_commit_conflict' });
  assert.equal(called, false);
});
