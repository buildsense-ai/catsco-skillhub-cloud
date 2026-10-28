// Synthetic retained metadata for status validation/transport tests; real
// PostgreSQL and worker completion coverage lives in the release-plan suite.
export function descriptionReleaseStatusFixture() {
  const request = { schemaVersion: 1, applicationId: 'pubdesc_' + 'a'.repeat(64), permitId: 'pubdescpermit_' + 'b'.repeat(32),
    publicationReceipt: { schemaVersion: 1, entryRequestId: 'pubentry_' + 'c'.repeat(32), candidateRevision: 1, acceptanceEpoch: 1,
      requestHash: 'd'.repeat(64), sourceSnapshotHash: 'e'.repeat(64), requestBytes: 1024, delegationId: 'pubgrant_' + 'f'.repeat(32),
      idempotencyKey: 'pubcandidate_' + '1'.repeat(32), taskId: 'pubtask_12345678-1234-4123-8123-123456789abc',
      eventId: 'pubevent_12345678-1234-4123-8123-123456789abc' } };
  const target = { candidateHash: '2'.repeat(64), manifestHash: '3'.repeat(64), publisherUserId: 'owner-test',
    publisherProfileId: 'profile-test', namespace: 'alice', skillId: 'alice/example', version: '1.0.0',
    uploadId: 'upl_test', releaseAt: '2026-10-28T00:00:00.000Z', confirmVersionPublish: false };
  const row = { application_id: request.applicationId, task_id: request.publicationReceipt.taskId, permit_id: request.permitId,
    state: 'queued', target, plan_target: structuredClone(target), plan_receipt: structuredClone(request.publicationReceipt),
    proof: { schemaVersion: 1, applicationId: request.applicationId, entryId: request.publicationReceipt.entryRequestId,
      target: structuredClone(target), permitId: request.permitId, intentHash: '4'.repeat(64), authorizedAt: target.releaseAt },
    derived_candidate_hash: target.candidateHash, publication_result: null, error_code: null };
  const publish = () => {
    row.state = 'published';
    row.publication_result = { skillId: target.skillId, version: target.version, packageId: 'pkg_12345678-1234-4123-8123-123456789abc',
      checksumSha256: '5'.repeat(64), publishedAt: target.releaseAt, privateField: '/private/never-return' };
    Object.assign(row, { package_id: row.publication_result.packageId, package_skill_id: target.skillId, package_version: target.version,
      package_checksum: row.publication_result.checksumSha256, package_published_at: new Date(target.releaseAt),
      package_upload_id: target.uploadId, package_owner_id: target.publisherUserId });
  };
  const queries = [];
  const store = { tx: async fn => fn({ query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.startsWith('SELECT ') ? [row] : [] };
  } }) };
  return { request, target, row, publish, store, queries };
}
