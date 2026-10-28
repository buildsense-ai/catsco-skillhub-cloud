import { canonicalJson } from '../signing/index.js';
import { validPublicationReceipt } from '../publication-delegation/receipt-client.js';
import { validPublicationPeerOrigin } from '../publication-delegation/introspection.js';
import { validPublicationCommitTarget } from '../publication-delegation/commit-permit-client.js';
import { validDescriptionReleasePermit } from './release-permit-client.js';
import { PublicationDescriptionDerivationError } from './store.js';

const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const matches = (v, pattern) => typeof v === 'string' && v.match(pattern)?.[0] === v;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = (kind, status = 409) => { throw new PublicationDescriptionDerivationError(kind, status); };
const states = ['queued', 'publishing', 'committing', 'published', 'publish_failed'];
const failurePrefix = 'skillhub.publication_description_release_commit_';
const failures = ['unavailable', 'copy_changed', 'rejected', 'publisher_changed', 'conflict', 'artifact_changed', 'invalid', 'lease_lost'];

export function validDescriptionReleaseStatusRequest(input) {
  return exact(input, ['schemaVersion', 'applicationId', 'permitId', 'publicationReceipt']) && input.schemaVersion === 1
    && matches(input.applicationId, /^pubdesc_[a-f0-9]{64}$/)
    && matches(input.permitId, /^pubdescpermit_[a-f0-9]{32}$/)
    && validPublicationReceipt(input.publicationReceipt);
}

// Historical evidence only: no candidate bytes, source refresh, permit recovery,
// worker scheduling or authority to execute. CatsCo must check its current actor
// before using this private peer response. Expiry must not erase a final result.
export function createPublicationDescriptionReleaseStatusReader({ enabled = false, store, issuer, audience } = {}) {
  return Object.freeze({
    async read(input) {
      if (enabled !== true) fail('disabled', 404);
      if (!validDescriptionReleaseStatusRequest(input)) fail('invalid', 400);
      if (typeof store?.tx !== 'function' || !validPublicationPeerOrigin(issuer) || !validPublicationPeerOrigin(audience)
        || issuer === audience) fail('configuration', 503);
      input = structuredClone(input);
      const r = input.publicationReceipt;
      try {
        const row = await store.tx(async client => {
          await client.query('SET TRANSACTION READ ONLY');
          await client.query("SET LOCAL statement_timeout='5s'");
          return (await client.query(`SELECT c.application_id,c.task_id,c.permit_id,c.state,c.target,c.publication_result,c.error_code,
              p.target AS plan_target,p.receipt AS plan_receipt,a.proof,d.derived_candidate_hash,
              v.id AS package_id,v.skill_id AS package_skill_id,v.version AS package_version,
              v.checksum_sha256 AS package_checksum,v.published_at AS package_published_at,
              v.upload_id AS package_upload_id,v.owner_user_id AS package_owner_id
            FROM publication_description_release_commits c
            JOIN publication_description_release_plans p USING(application_id,task_id)
            JOIN publication_description_release_admissions a USING(application_id,task_id,permit_id)
            JOIN publication_description_derivations d USING(application_id,task_id)
            JOIN publication_tasks t ON t.id=c.task_id
            JOIN publication_delegations delegation ON delegation.task_id=t.id
            JOIN publication_delegation_outbox o ON o.task_id=t.id
            LEFT JOIN skill_versions v ON v.id=c.publication_result->>'packageId'
            WHERE c.application_id=$1 AND c.permit_id=$2 AND t.id=$3 AND t.authority_kind='catsco'
              AND delegation.issuer=$4 AND delegation.audience=$5 AND delegation.entry_request_id=$6
              AND delegation.candidate_revision=$7 AND delegation.authority_epoch=$8
              AND t.request_hash=$9 AND t.candidate_hash=$10 AND delegation.request_bytes=$11
              AND delegation.delegation_id=$12 AND t.request_key=$13 AND o.event_id=$14`,
          [input.applicationId, input.permitId, r.taskId, issuer, audience, r.entryRequestId,
            r.candidateRevision, r.acceptanceEpoch, r.requestHash, r.sourceSnapshotHash, r.requestBytes,
            r.delegationId, r.idempotencyKey, r.eventId])).rows[0];
        });
        if (!row) fail('not_found', 404);
        if (row.application_id !== input.applicationId || row.task_id !== r.taskId || row.permit_id !== input.permitId
          || !states.includes(row.state) || !validPublicationCommitTarget(row.target)
          || row.target.candidateHash !== row.derived_candidate_hash || !same(row.target, row.plan_target)
          || !same(row.plan_receipt, r) || row.proof?.permitId !== input.permitId
          || !validDescriptionReleasePermit(row.proof, { schemaVersion: 1, entryId: r.entryRequestId,
            applicationId: input.applicationId, target: row.target })) fail('conflict');
        let result = null;
        if (row.state === 'published') {
          const p = row.publication_result;
          if (!p || p.skillId !== row.target.skillId || p.version !== row.target.version || p.publishedAt !== row.target.releaseAt
            || !matches(p.packageId, /^pkg_[a-f0-9-]{36}$/) || !matches(p.checksumSha256, /^[a-f0-9]{64}$/)
            || row.package_id !== p.packageId || row.package_skill_id !== p.skillId || row.package_version !== p.version
            || row.package_checksum !== p.checksumSha256 || row.package_upload_id !== row.target.uploadId
            || row.package_owner_id !== row.target.publisherUserId
            || new Date(row.package_published_at).getTime() !== new Date(p.publishedAt).getTime()
            || row.error_code !== null) fail('conflict');
          result = Object.fromEntries(['skillId', 'version', 'packageId', 'checksumSha256', 'publishedAt'].map(key => [key, p[key]]));
        } else if (row.publication_result !== null) fail('conflict');
        let errorCode = null;
        if (row.state === 'publish_failed') {
          const kind = typeof row.error_code === 'string' && row.error_code.startsWith(failurePrefix)
            ? row.error_code.slice(failurePrefix.length) : row.error_code;
          errorCode = failurePrefix + (failures.includes(kind) ? kind : 'unavailable');
        }
        return { schemaVersion: 1, applicationId: input.applicationId, taskId: row.task_id, permitId: input.permitId,
          publicationReceipt: r, state: row.state, target: structuredClone(row.target), result, errorCode };
      } catch (error) {
        if (error instanceof PublicationDescriptionDerivationError) throw error;
        fail('unavailable', 503);
      }
    }
  });
}
