import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../signing/index.js';
import { publicManifest } from '../domain/index.js';
import { validPublicationReceipt } from '../publication-delegation/receipt-client.js';
import { validPublicationCommitTarget } from '../publication-delegation/commit-permit-client.js';
import { validPublicationPeerOrigin } from '../publication-delegation/introspection.js';
import { publicationTaskSettings } from '../publication-tasks/config.js';
import { runPublishValidation } from '../publish-validation/runner.js';
import { runPreparePublication } from '../publication-tasks/prepare.js';
import { lockPublicSkill, reservePublicVersion } from '../publication-tasks/versions.js';
import { readPublicationDescriptionCopy, validDescriptionCopyRead } from './read.js';
import { PublicationDescriptionDerivationError } from './store.js';
import { validDescriptionReleasePermit, PublicationDescriptionReleasePermitError } from './release-permit-client.js';

const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = v => createHash('sha256').update(canonicalJson(v)).digest('hex');
const fail = (kind, status = 409) => { throw new PublicationDescriptionDerivationError(kind, status); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export function validDescriptionReleasePlanRequest(input) {
  return exact(input, ['copy', 'publicationReceipt', 'confirmVersionPublish'])
    && validDescriptionCopyRead(input.copy) && validPublicationReceipt(input.publicationReceipt)
    && typeof input.confirmVersionPublish === 'boolean'
    && input.copy.taskId === input.publicationReceipt.taskId
    && input.copy.requestHash === input.publicationReceipt.requestHash
    && input.copy.candidateHash === input.publicationReceipt.sourceSnapshotHash;
}

// Planning only. No permit request, task/round transition, model execution,
// original-candidate rewrite or packaging job. The trusted CatsCo caller must
// bind this response to current exact confirmation/acceptance before release.
export function createPublicationDescriptionReleasePlanner({ enabled = false, releasePermitEnabled = false, config, store, issuer, audience, permitClient } = {}) {
  let settings;
  if (enabled === true) {
    if (!store?.tx || !store?.query || !store?.getPublicationDescriptionDerivation || !store?.getPublicationDescriptionDerivationSource
      || !validPublicationPeerOrigin(issuer) || !validPublicationPeerOrigin(audience)
      || new URL(issuer).origin === new URL(audience).origin) fail('configuration', 503);
    try { settings = publicationTaskSettings(config); } catch { fail('configuration', 503); }
    if (!settings || config.publicationPublishing?.enabled !== true) fail('configuration', 503);
    if (releasePermitEnabled === true && (!permitClient?.authorize || config.publicationDescriptionDerivation?.planEnabled !== true)) fail('configuration', 503);
  }
  const transaction = fn => store.tx(async c => {
    await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("SET LOCAL statement_timeout='10s'");
    return fn(c);
  });
  const load = async (c, input, locked = false) => {
    const r = input.publicationReceipt;
    if (locked) await c.query('SELECT id FROM publication_tasks WHERE id=$1 FOR UPDATE', [r.taskId]);
    const row = (await c.query(`SELECT t.*,d.actor_uid,d.profile_id,d.namespace,d.issuer,d.audience,
      p.application_id AS plan_application,p.receipt AS plan_receipt,p.copy_request,p.target,p.manifest,p.identity,
      EXISTS(SELECT 1 FROM publication_commits WHERE task_id=t.id) AS commit_started,
      EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=t.id) AS original_planned
      FROM publication_tasks t JOIN publication_delegations d ON d.task_id=t.id
      JOIN publication_delegation_outbox o ON o.task_id=t.id
      LEFT JOIN publication_description_release_plans p ON p.task_id=t.id
      WHERE t.id=$1 AND t.authority_kind='catsco' AND d.issuer=$2 AND d.audience=$3
        AND d.entry_request_id=$4 AND d.candidate_revision=$5 AND d.authority_epoch=$6
        AND t.request_hash=$7 AND t.candidate_hash=$8 AND d.request_bytes=$9
        AND d.delegation_id=$10 AND t.request_key=$11 AND o.event_id=$12`,
    [r.taskId, issuer, audience, r.entryRequestId, r.candidateRevision, r.acceptanceEpoch,
      r.requestHash, r.sourceSnapshotHash, r.requestBytes, r.delegationId, r.idempotencyKey, r.eventId])).rows[0];
    if (!row) fail('source_unavailable');
    if (row.state !== 'delegated_pending' || row.commit_started || row.original_planned || !Buffer.isBuffer(row.candidate)
      || !(await c.query('SELECT $1::timestamptz>clock_timestamp() AS live', [row.expires_at])).rows[0].live) fail('source_unavailable');
    if (row.target && (row.plan_application !== input.copy.applicationId || !equal(row.plan_receipt, r)
      || !equal(row.copy_request, input.copy) || !validPublicationCommitTarget(row.target)
      || row.target.candidateHash !== input.copy.expectedReceipt.derivedCandidateHash
      || row.target.manifestHash !== hash(row.manifest) || row.target.publisherUserId !== row.owner_user_id
      || row.target.publisherProfileId !== row.profile_id || row.target.namespace !== row.namespace
      || row.target.confirmVersionPublish !== input.confirmVersionPublish)) fail('conflict');
    return row;
  };
  const authority = async (c, row) => {
    if (!(await c.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [row.owner_user_id])).rowCount) fail('publisher_changed', 403);
    const p = (await c.query("SELECT id,namespace,catsco_uid,catsco_issuer FROM publisher_profiles WHERE user_id=$1 AND status='active' FOR SHARE", [row.owner_user_id])).rows[0];
    if (!p || p.id !== row.profile_id || p.namespace !== row.namespace || p.catsco_uid !== row.actor_uid || p.catsco_issuer !== issuer) fail('publisher_changed', 403);
  };
  const view = (row, input) => ({ schemaVersion: 1, applicationId: input.copy.applicationId, taskId: input.copy.taskId,
    publicationReceipt: structuredClone(input.publicationReceipt), receipt: structuredClone(input.copy.expectedReceipt),
    derivedBytes: input.copy.derivedBytes, target: structuredClone(row.target) });
  const releaseRow = async (c, input, lock = false) => {
    const receipt = input.publicationReceipt;
    if (lock) await c.query('SELECT id FROM publication_tasks WHERE id=$1 FOR UPDATE', [receipt.taskId]);
    const row = (await c.query(`SELECT t.*,d.actor_uid,d.profile_id,d.namespace,d.issuer,d.audience,
      p.application_id AS plan_application,p.receipt AS plan_receipt,p.copy_request,p.target,p.manifest,p.identity,
      a.derived_candidate_hash,a.derived_request_hash,a.derived_raw_json,auth.state AS authorization_state,
      auth.proof AS authorization_proof,auth.terminal_code,auth.attempt_token AS authorization_attempt_token,
      auth.attempt_lease_until AS authorization_attempt_lease_until,
      EXISTS(SELECT 1 FROM publication_commits WHERE task_id=t.id) AS commit_started,
      EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=t.id) AS original_planned
      FROM publication_tasks t JOIN publication_delegations d ON d.task_id=t.id
      JOIN publication_delegation_outbox o ON o.task_id=t.id
      LEFT JOIN publication_description_release_plans p ON p.task_id=t.id
      LEFT JOIN publication_description_derivations a ON a.application_id=p.application_id
      LEFT JOIN publication_description_release_authorizations auth ON auth.application_id=p.application_id
      WHERE t.id=$1 AND t.authority_kind='catsco' AND d.issuer=$2 AND d.audience=$3
        AND d.entry_request_id=$4 AND d.candidate_revision=$5 AND d.authority_epoch=$6
        AND t.request_hash=$7 AND t.candidate_hash=$8 AND d.request_bytes=$9
        AND d.delegation_id=$10 AND t.request_key=$11 AND o.event_id=$12`,
    [receipt.taskId, issuer, audience, receipt.entryRequestId, receipt.candidateRevision, receipt.acceptanceEpoch,
      receipt.requestHash, receipt.sourceSnapshotHash, receipt.requestBytes, receipt.delegationId, receipt.idempotencyKey, receipt.eventId])).rows[0];
    if (!row || row.plan_application !== input.applicationId || !equal(row.plan_receipt, receipt)
      || !validPublicationCommitTarget(row.target)
      || row.target.candidateHash !== row.derived_candidate_hash || row.target.manifestHash !== hash(row.manifest)
      || row.target.publisherUserId !== row.owner_user_id || row.target.publisherProfileId !== row.profile_id
      || row.target.namespace !== row.namespace || !row.identity || !row.copy_request) fail('conflict');
    return row;
  };
  const chargeAuthorization = async (c, id, owner) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('skillhub-publication-task-intake')::bigint)");
    await c.query(`UPDATE publication_tasks SET commit_bytes=
      COALESCE((SELECT octet_length(to_jsonb(p)::text) FROM publication_description_release_plans p WHERE p.task_id=$1),0)
      +COALESCE((SELECT octet_length(to_jsonb(a)::text) FROM publication_description_release_admissions a WHERE a.task_id=$1),0)
      +16384 WHERE id=$1`, [id]);
    const usage = (await c.query(`SELECT COALESCE(sum(candidate_bytes+commit_bytes),0)::bigint AS total,
      COALESCE(sum(candidate_bytes+commit_bytes) FILTER (WHERE owner_user_id=$1),0)::bigint AS owned FROM publication_tasks`, [owner])).rows[0];
    if (BigInt(usage.total) > BigInt(settings.maxStoredBytes) || BigInt(usage.owned) > BigInt(settings.maxStoredBytesPerOwner)) fail('storage_limit', 429);
  };
  const admitRelease = async (c, row, input) => {
    const proof = row.authorization_proof;
    if (!validDescriptionReleasePermit(proof, { schemaVersion: 1, entryId: input.publicationReceipt.entryRequestId,
      applicationId: input.applicationId, target: row.target })) fail('conflict');
    await c.query(`INSERT INTO publication_description_release_admissions(application_id,task_id,permit_id,proof)
      VALUES($1,$2,$3,$4) ON CONFLICT(application_id) DO NOTHING`,
    [input.applicationId, row.id, proof.permitId, JSON.stringify(proof)]);
    const admitted = (await c.query(`SELECT task_id,permit_id,proof FROM publication_description_release_admissions
      WHERE application_id=$1`, [input.applicationId])).rows[0];
    if (!admitted || admitted.task_id !== row.id || admitted.permit_id !== proof.permitId || !equal(admitted.proof, proof)) fail('conflict');
    await chargeAuthorization(c, row.id, row.owner_user_id);
  };
  const authorizationFailure = error => {
    const kind = error instanceof PublicationDescriptionReleasePermitError
      ? error.code.replace('skillhub.publication_description_release_permit_', '') : 'unavailable';
    if (['denied', 'cancelled', 'conflict'].includes(kind)) {
      return new PublicationDescriptionDerivationError(kind, kind === 'denied' ? 403 : 409);
    }
    return new PublicationDescriptionDerivationError('unavailable', 503);
  };
  let active = 0;
  return Object.freeze({ async plan(input, { signal } = {}) {
    if (enabled !== true) fail('disabled', 404);
    if (!validDescriptionReleasePlanRequest(input)) fail('invalid', 400);
    if (active >= 2) fail('busy', 503);
    input = structuredClone(input);
    const check = () => { if (signal?.aborted) fail('unavailable', 503); };
    active++;
    try {
      check();
      // Check publisher before the bounded worker. No DB locks span worker work.
      const initial = await transaction(async c => { const row = await load(c, input, true); await authority(c, row); return row; });
      const bytes = await readPublicationDescriptionCopy(store, input.copy, settings.limits,
        { signal, timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb });
      check();
      let derived;
      if (!initial.target) {
        derived = await runPublishValidation({ candidate: bytes, requestHash: input.copy.expectedReceipt.derivedRequestHash,
          candidateHash: input.copy.expectedReceipt.derivedCandidateHash, namespace: initial.namespace }, settings.limits,
        { workerUrl: new URL('../publication-tasks/draft-worker.js', import.meta.url),
          signal, timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb });
        if (derived.status !== 200) fail(derived.status >= 500 ? 'unavailable' : 'copy_changed', derived.status >= 500 ? 503 : 409);
      }
      check();
      return await transaction(async c => {
        const row = await load(c, input, true);
        await authority(c, row);
        const retained = (await c.query('SELECT derived_raw_json,derivation_receipt,proposal FROM publication_description_derivations WHERE application_id=$1', [input.copy.applicationId])).rows[0];
        if (!retained || !Buffer.isBuffer(retained.derived_raw_json) || !retained.derived_raw_json.equals(bytes)
          || !equal(retained.derivation_receipt, input.copy.expectedReceipt) || !equal(retained.proposal, input.copy.proposal)
          || !row.candidate.equals(initial.candidate)) fail('copy_changed');
        check();
        if (row.target) return view(row, input);
        if (!derived) fail('conflict');
        const draft = publicManifest(derived.manifest);
        await lockPublicSkill(c, draft.id);
        const occupied = await c.query('SELECT 1 FROM skill_versions WHERE skill_id=$1 UNION ALL '
          + 'SELECT 1 FROM publication_version_reservations WHERE skill_id=$1 UNION ALL '
          + "SELECT 1 FROM jobs WHERE type='publish_skill_version' AND payload->'manifest'->>'id'=$1 LIMIT 1", [draft.id]);
        if (occupied.rowCount && !input.confirmVersionPublish) fail('version_confirmation_required');
        const uploadId = 'upl_' + randomUUID();
        const reserved = await reservePublicVersion(c, { uploadId, skillId: draft.id, ownerId: row.owner_user_id, version: draft.version });
        const identity = { ownerId: row.owner_user_id, uploadId, skillId: draft.id, version: reserved.version, releaseAt: new Date().toISOString() };
        const skillHub = { author: row.namespace, version: identity.version, uploadedAt: identity.releaseAt };
        const manifest = { ...draft, version: identity.version, skillHub, skillhub_author: skillHub.author,
          skillhub_version: skillHub.version, skillhub_uploaded_at: skillHub.uploadedAt };
        const target = { candidateHash: input.copy.expectedReceipt.derivedCandidateHash, manifestHash: hash(manifest),
          publisherUserId: row.owner_user_id, publisherProfileId: row.profile_id, namespace: row.namespace,
          skillId: draft.id, version: identity.version, uploadId, releaseAt: identity.releaseAt,
          confirmVersionPublish: input.confirmVersionPublish };
        if (!validPublicationCommitTarget(target)) fail('conflict');
        await c.query(`INSERT INTO publication_description_release_plans(application_id,task_id,receipt,copy_request,target,manifest,identity)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.copy.applicationId, input.copy.taskId, JSON.stringify(input.publicationReceipt),
          JSON.stringify(input.copy), JSON.stringify(target), JSON.stringify(manifest), JSON.stringify(identity)]);
        await c.query("SELECT pg_advisory_xact_lock(hashtext('skillhub-publication-task-intake')::bigint)");
        await c.query(`UPDATE publication_tasks SET commit_bytes=(SELECT octet_length(to_jsonb(p)::text)
          FROM publication_description_release_plans p WHERE p.task_id=$1) WHERE id=$1`, [input.copy.taskId]);
        const usage = (await c.query(`SELECT COALESCE(sum(candidate_bytes+commit_bytes),0)::bigint AS total,
          COALESCE(sum(candidate_bytes+commit_bytes) FILTER (WHERE owner_user_id=$1),0)::bigint AS owned FROM publication_tasks`, [row.owner_user_id])).rows[0];
        if (BigInt(usage.total) > BigInt(settings.maxStoredBytes) || BigInt(usage.owned) > BigInt(settings.maxStoredBytesPerOwner)) fail('storage_limit', 429);
        check();
        return view({ target }, input);
      });
    } catch (error) {
      if (error instanceof PublicationDescriptionDerivationError) throw error;
      fail('unavailable', 503);
    } finally { active--; }
  }, async authorize(input, { signal } = {}) {
    if (enabled !== true || releasePermitEnabled !== true) fail('disabled', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
      || !Object.hasOwn(input, 'schemaVersion') || !Object.hasOwn(input, 'applicationId')
      || !Object.hasOwn(input, 'publicationReceipt') || input.schemaVersion !== 1
      || !/^pubdesc_[a-f0-9]{64}$/.test(input.applicationId) || !validPublicationReceipt(input.publicationReceipt)) fail('invalid', 400);
    if (active >= 2) fail('busy', 503);
    input = structuredClone(input);
    const check = () => { if (signal?.aborted) fail('unavailable', 503); };
    const attemptToken = `pubdescattempt_${randomUUID()}`;
    active++;
    try {
      check();
      let row = await transaction(async c => {
        const current = await releaseRow(c, input, true);
        if (current.authorization_state === 'denied') fail(current.terminal_code ?? 'conflict', current.terminal_code === 'denied' ? 403 : 409);
        if (current.authorization_state === 'permitted') {
          if (!validDescriptionReleasePermit(current.authorization_proof, {
            schemaVersion: 1, entryId: input.publicationReceipt.entryRequestId, applicationId: input.applicationId, target: current.target
          })) fail('conflict');
          // A recovered/previously stored permit is admitted to the isolated
          // derived-release lane exactly once. This is not a publication commit.
          await admitRelease(c, current, input);
          return current;
        }
        if (current.authorization_state === 'pending') {
          const claimed = await c.query(`UPDATE publication_description_release_authorizations
            SET attempt_token=$2,attempt_lease_until=clock_timestamp()+interval '15 seconds'
            WHERE application_id=$1 AND state='pending'
              AND attempt_lease_until<=clock_timestamp()
            RETURNING application_id`, [input.applicationId, attemptToken]);
          if (!claimed.rowCount) fail('busy', 503);
          return { ...current, authorization_attempt_token: attemptToken };
        }
        await authority(c, current);
        if (current.state !== 'delegated_pending' || current.commit_started || current.original_planned || !Buffer.isBuffer(current.candidate)
          || !(await c.query('SELECT $1::timestamptz>clock_timestamp() AS live', [current.expires_at])).rows[0].live) fail('source_unavailable');
        return current;
      });
      if (row.authorization_state === 'permitted') {
        return { schemaVersion: 1, applicationId: input.applicationId, permit: structuredClone(row.authorization_proof), replayed: true };
      }
      if (!row.authorization_state) {
        const copy = row.copy_request;
        const bytes = await readPublicationDescriptionCopy(store, copy, settings.limits,
          { signal, timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb });
        if (!Buffer.isBuffer(row.derived_raw_json) || !row.derived_raw_json.equals(bytes)
          || copy.expectedReceipt?.derivedRequestHash !== row.derived_request_hash
          || copy.expectedReceipt?.derivedCandidateHash !== row.target.candidateHash) fail('copy_changed');
        const prepared = await runPreparePublication({ rawJson: bytes, requestHash: row.derived_request_hash,
          candidateHash: row.derived_candidate_hash, manifest: row.manifest, identity: row.identity }, settings.limits,
        { timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb, signal });
        if (prepared.status !== 200 || !equal(prepared.prepared.manifest, row.manifest)
          || !equal(prepared.prepared.receipt.identity, row.identity)) fail(prepared.status >= 500 ? 'unavailable' : 'copy_changed', prepared.status >= 500 ? 503 : 409);
        check();
        row = await transaction(async c => {
          const current = await releaseRow(c, input, true);
          if (current.authorization_state) return current;
          await authority(c, current);
          if (current.state !== 'delegated_pending' || current.commit_started || current.original_planned || !Buffer.isBuffer(current.candidate)
            || !(await c.query('SELECT $1::timestamptz>clock_timestamp() AS live', [current.expires_at])).rows[0].live) fail('source_unavailable');
          await c.query(`INSERT INTO publication_description_release_authorizations
            (application_id,task_id,state,attempt_token,attempt_lease_until)
            VALUES($1,$2,'pending',$3,clock_timestamp()+interval '15 seconds')`,
          [input.applicationId, input.publicationReceipt.taskId, attemptToken]);
          await chargeAuthorization(c, current.id, current.owner_user_id);
          return { ...current, authorization_state: 'pending', authorization_attempt_token: attemptToken };
        });
        if (row.authorization_state === 'permitted') {
          await admitRelease(c, row, input);
          return { schemaVersion: 1, applicationId: input.applicationId, permit: structuredClone(row.authorization_proof), replayed: true };
        }
        if (row.authorization_state === 'denied') fail(row.terminal_code ?? 'conflict', row.terminal_code === 'denied' ? 403 : 409);
      }
      if (row.authorization_state !== 'pending' || row.authorization_attempt_token !== attemptToken) fail('busy', 503);
      check();
      const request = { schemaVersion: 1, entryId: input.publicationReceipt.entryRequestId,
        applicationId: input.applicationId, target: structuredClone(row.target) };
      let proof;
      try { proof = await permitClient.authorize(request, { signal }); }
      catch (error) {
        const terminal = error instanceof PublicationDescriptionReleasePermitError
          ? ({ denied: 'denied', cancelled: 'cancelled', conflict: 'conflict' })[error.code.replace('skillhub.publication_description_release_permit_', '')] : null;
        if (terminal) {
          await transaction(async c => {
            const current = await releaseRow(c, input, true);
            if (current.authorization_state === 'pending' && current.authorization_attempt_token === attemptToken) {
              await c.query(`UPDATE publication_description_release_authorizations
                SET state='denied',terminal_code=$2,attempt_token=NULL,attempt_lease_until=NULL
                WHERE application_id=$1 AND state='pending' AND attempt_token=$3`, [input.applicationId, terminal, attemptToken]);
            }
          });
        }
        throw authorizationFailure(error);
      }
      if (!validDescriptionReleasePermit(proof, request)) fail('conflict');
      check();
      let stored = false;
      row = await transaction(async c => {
        const current = await releaseRow(c, input, true);
        if (current.authorization_state === 'permitted') {
          if (!equal(current.authorization_proof, proof)) fail('conflict');
          return current;
        }
        if (current.authorization_state !== 'pending') fail('conflict');
        const saved = await c.query(`UPDATE publication_description_release_authorizations
          SET state='permitted',proof=$2,attempt_token=NULL,attempt_lease_until=NULL
          WHERE application_id=$1 AND state='pending' AND attempt_token=$3 RETURNING application_id`,
        [input.applicationId, JSON.stringify(proof), attemptToken]);
        if (saved.rowCount !== 1) fail('conflict');
        stored = true;
        await admitRelease(c, { ...current, authorization_proof: proof }, input);
        return { ...current, authorization_state: 'permitted', authorization_proof: proof };
      });
      return { schemaVersion: 1, applicationId: input.applicationId, permit: structuredClone(row.authorization_proof), replayed: !stored };
    } catch (error) {
      if (error instanceof PublicationDescriptionDerivationError) throw error;
      fail('unavailable', 503);
    } finally { active--; }
  } });
}
