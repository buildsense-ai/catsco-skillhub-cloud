import { createHash } from 'node:crypto';
import { validPublicationPeerOrigin } from './introspection.js';
import { validPublicationReceipt } from './receipt-client.js';
import { delegatedValidationReport } from './validation-report.js';

export const REPAIR_MATERIAL_MAX_BYTES = 32 * 1024 * 1024;
export class PublicationRepairMaterialError extends Error {
  constructor(kind = 'unavailable') {
    if (!['disabled', 'configuration', 'invalid', 'unavailable', 'not_found', 'conflict', 'busy'].includes(kind)) kind = 'unavailable';
    super('Private publication material is unavailable.');
    this.code = `skillhub.publication_repair_material_${kind}`;
    this.kind = kind;
  }
}
const fail = kind => { throw new PublicationRepairMaterialError(kind); };

// Private original-candidate byte read ONLY. The service peer must independently
// check the current CatsCo task/human/Bot/Runtime before and after calling this.
// A receipt is lookup identity, not model execution or publication authority.
export function createPublicationRepairMaterialReader({ enabled = false, store, issuer, audience } = {}) {
  if (enabled === true && (typeof store?.tx !== 'function' || !validPublicationPeerOrigin(issuer)
    || !validPublicationPeerOrigin(audience) || issuer === audience)) fail('configuration');
  let active = 0;
  return Object.freeze({ async read(receipt, { signal } = {}) {
    if (enabled !== true) fail('disabled');
    if (!validPublicationReceipt(receipt) || receipt.requestBytes > REPAIR_MATERIAL_MAX_BYTES) fail('invalid');
    if (active >= 2) fail('busy');
    const r = Object.freeze({ ...receipt });
    const check = () => { if (signal?.aborted) fail('unavailable'); };
    check(); active++;
    try {
      const bytes = await store.tx(async c => {
        check();
        await c.query("SET LOCAL lock_timeout='3s'");
        await c.query("SET LOCAL statement_timeout='5s'");
        // Lock first, then use a NEW snapshot after any wait. Cancellation and
        // commit transitions serialize on this task. Only metadata is read here.
        await c.query('SELECT id FROM publication_tasks WHERE id=$1 FOR SHARE', [r.taskId]);
        check();
        const row = (await c.query(`SELECT t.candidate,t.candidate_bytes,t.intake_result
          FROM publication_tasks t JOIN publication_delegations d ON d.task_id=t.id
          JOIN publication_delegation_outbox o ON o.task_id=t.id
          JOIN users u ON u.id=t.owner_user_id AND u.status='active'
          JOIN publisher_profiles p ON p.user_id=u.id AND p.status='active'
            AND p.id=d.profile_id AND p.namespace=d.namespace
            AND p.catsco_uid=d.actor_uid AND p.catsco_issuer=d.issuer
          WHERE t.id=$1 AND t.authority_kind='catsco' AND d.issuer=$2 AND d.audience=$3
            AND d.entry_request_id=$4 AND d.candidate_revision=$5 AND d.authority_epoch=$6
            AND t.request_hash=$7 AND t.candidate_hash=$8 AND d.request_bytes=$9
            AND d.delegation_id=$10 AND t.request_key=$11 AND o.event_id=$12
            AND t.state='delegated_pending' AND t.delegated_cancelled_at IS NULL
            AND t.expires_at>clock_timestamp() AND t.candidate_bytes=$9
            AND octet_length(t.candidate)=$9 AND t.candidate_bytes BETWEEN 1 AND $13
            AND NOT EXISTS (SELECT 1 FROM publication_commits c WHERE c.task_id=t.id)
            AND NOT EXISTS (SELECT 1 FROM publication_delegated_permits proof WHERE proof.task_id=t.id)
          FOR SHARE OF t,u,p`, [r.taskId, issuer, audience, r.entryRequestId, r.candidateRevision,
          r.acceptanceEpoch, r.requestHash, r.sourceSnapshotHash, r.requestBytes, r.delegationId,
          r.idempotencyKey, r.eventId, REPAIR_MATERIAL_MAX_BYTES])).rows[0];
        check();
        if (!row) fail('not_found');
        if (!Buffer.isBuffer(row.candidate) || row.candidate.length !== r.requestBytes
          || Number(row.candidate_bytes) !== r.requestBytes) fail('conflict');
        const raw = Buffer.from(row.candidate);
        if (createHash('sha256').update(raw).digest('hex') !== r.requestHash) fail('conflict');
        const report = delegatedValidationReport(row.intake_result, r.sourceSnapshotHash);
        // The first repair lane reads only a complete retained rejection, not
        // a passed upload or a partial report. It never regenerates that report.
        if (report.outcome !== 'rejected' || report.truncated) fail('conflict');
        check();
        // A lock wait / slow DB operation must not release expired bytes.
        const live = (await c.query('SELECT expires_at>clock_timestamp() AS live FROM publication_tasks WHERE id=$1', [r.taskId])).rows[0];
        check();
        if (live?.live !== true) fail('not_found');
        return raw;
      });
      check();
      return bytes;
    } catch (error) {
      if (error instanceof PublicationRepairMaterialError) throw error;
      // Never expose SQL, report text, candidate bytes, credentials or causes.
      fail('unavailable');
    } finally { active--; }
  } });
}
