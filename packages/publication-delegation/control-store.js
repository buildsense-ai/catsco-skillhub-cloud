import { validPublicationPeerOrigin } from './introspection.js';
import { validPublicationReceipt } from './receipt-client.js';

export class PublicationControlError extends Error {
  constructor(kind = 'storage') {
    const messages = {
      disabled: 'Delegated publication control is disabled.',
      configuration: 'Delegated publication control configuration is unavailable.',
      invalid: 'Delegated publication reference is invalid.',
      not_found: 'Delegated publication reference is unavailable.',
      conflict: 'Delegated publication cannot be cancelled in this state.',
      busy: 'Delegated publication control is busy.',
      storage: 'Delegated publication control storage is unavailable.'
    };
    if (!Object.hasOwn(messages, kind)) kind = 'storage';
    super(messages[kind]);
    this.name = 'PublicationControlError';
    this.code = `skillhub.publication_control_${kind}`;
  }
}

// INTERNAL STORAGE PRIMITIVE, not an authentication adapter. No API/worker
// imports it. A future independently authenticated CatsCo peer adapter must
// authorize the human action and durably record cancel intent BEFORE invoking
// cancel. Receipt IDs, an upload grant, a session, and localIntentCancelled in
// an ACK are not cancellation authority. Never expose this store directly.
export function createDelegatedPublicationControlStore({ enabled = false, store, issuer, audience } = {}) {
  const activeConfig = enabled === true;
  if (activeConfig && (!store?.tx || !validPublicationPeerOrigin(issuer) ||
      !validPublicationPeerOrigin(audience) || new URL(issuer).origin === new URL(audience).origin)) {
    throw new PublicationControlError('configuration');
  }
  let active = 0;
  async function observe(receipt, cancel) {
    if (!activeConfig) throw new PublicationControlError('disabled');
    if (!validPublicationReceipt(receipt)) throw new PublicationControlError('invalid');
    if (active >= 16) throw new PublicationControlError('busy');
    const r = Object.freeze({ ...receipt });
    active++;
    try {
      return await store.tx(async c => {
        await c.query("SET LOCAL lock_timeout='5s'");
        await c.query("SET LOCAL statement_timeout='10s'");
        // Metadata only. Same task-row ordering point as the future commit
        // transition; no network or workspace work while this lock is held.
        // Historical reads need no current profile/namespace/online Bot join.
        const row = (await c.query(`SELECT t.state,t.candidate_bytes,t.expires_at,t.delegated_cancelled_at
          FROM publication_tasks t JOIN publication_delegations d ON d.task_id=t.id
          JOIN publication_delegation_outbox o ON o.task_id=t.id
          WHERE t.id=$1 AND t.authority_kind='catsco' AND d.issuer=$2 AND d.audience=$3
            AND d.entry_request_id=$4 AND d.candidate_revision=$5 AND d.authority_epoch=$6
            AND t.request_hash=$7 AND t.candidate_hash=$8 AND d.request_bytes=$9
            AND d.delegation_id=$10 AND t.request_key=$11 AND o.event_id=$12
          FOR ${cancel ? 'UPDATE' : 'SHARE'} OF t`,
        [r.taskId, issuer, audience, r.entryRequestId, r.candidateRevision, r.acceptanceEpoch,
          r.requestHash, r.sourceSnapshotHash, r.requestBytes, r.delegationId, r.idempotencyKey, r.eventId])).rows[0];
        if (!row) throw new PublicationControlError('not_found');
        // Fresh statement after obtaining the task lock, not a stale join
        // snapshot. Refuse any unrecognized execution evidence, never guess.
        const commits = await c.query('SELECT 1 FROM publication_commits WHERE task_id=$1', [r.taskId]);
        if (commits.rowCount || !['delegated_pending', 'cancelled'].includes(row.state)) {
          throw new PublicationControlError('conflict');
        }
        if (cancel && row.state !== 'cancelled') {
          const saved = (await c.query(`UPDATE publication_tasks SET state='cancelled',
            delegated_cancelled_at=clock_timestamp(),candidate=NULL,candidate_bytes=0,
            error_code=NULL,updated_at=clock_timestamp() WHERE id=$1
            RETURNING state,candidate_bytes,expires_at,delegated_cancelled_at`, [r.taskId])).rows[0];
          Object.assign(row, saved);
        }
        const now = (await c.query('SELECT clock_timestamp() AS observed_at')).rows[0].observed_at;
        return {
          schemaVersion: 1, entryRequestId: r.entryRequestId, taskId: r.taskId, candidateRevision: 1,
          executionState: row.state,
          candidateAvailable: row.state !== 'cancelled' && Number(row.candidate_bytes) > 0 && new Date(row.expires_at) > now,
          cancelledAt: row.delegated_cancelled_at ? new Date(row.delegated_cancelled_at).toISOString() : null,
          observedAt: new Date(now).toISOString()
        };
      });
    } catch (error) {
      if (error instanceof PublicationControlError) throw error;
      // No source, raw SQL, constraint detail, credentials or caller input.
      throw new PublicationControlError('storage');
    } finally { active--; }
  }
  return Object.freeze({ read: r => observe(r, false), cancel: r => observe(r, true) });
}
