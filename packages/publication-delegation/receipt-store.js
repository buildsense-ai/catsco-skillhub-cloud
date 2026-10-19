import { randomUUID } from 'node:crypto';
import { validPublicationPeerOrigin } from './introspection.js';
import { PublicationReceiptError, validPublicationReceipt } from './receipt-client.js';

// Internal ledger only. No ordinary account session API can claim/finish it.
export function createPublicationReceiptStore(store,{issuer,audience}) {
  if(!store?.tx||!validPublicationPeerOrigin(issuer)||!validPublicationPeerOrigin(audience)||new URL(issuer).origin===new URL(audience).origin)
    throw new PublicationReceiptError('configuration');
  const tx=async fn=>{
    try{return await store.tx(async c=>{
      await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='10s'");return fn(c);
    });}catch{throw new PublicationReceiptError('storage');}
  };
  return Object.freeze({
    async claim() {
      return tx(async c=>{
        // A crash on the last attempt must settle rather than remain leased
        // forever. Bounded maintenance cannot block a fresh unrelated event.
        await c.query(`WITH stale AS (
          SELECT o.task_id FROM publication_delegation_outbox o JOIN publication_delegations d USING(task_id)
          WHERE d.issuer=$1 AND d.audience=$2 AND o.delivery_state='leased' AND o.delivery_attempts=8
            AND o.lease_until<=clock_timestamp() ORDER BY o.lease_until LIMIT 16 FOR UPDATE OF o SKIP LOCKED)
          UPDATE publication_delegation_outbox o SET delivery_state='exhausted',last_code='exhausted',lease_token=NULL,lease_until=NULL
          FROM stale WHERE o.task_id=stale.task_id`,[issuer,audience]);
        const row=(await c.query(`SELECT o.task_id,o.event_id,o.delivery_attempts,d.entry_request_id,d.candidate_revision,
          d.authority_epoch,d.request_bytes,d.delegation_id,t.request_key,t.request_hash,t.candidate_hash
          FROM publication_delegation_outbox o JOIN publication_delegations d USING(task_id) JOIN publication_tasks t ON t.id=o.task_id
          WHERE d.issuer=$1 AND d.audience=$2 AND t.authority_kind='catsco'
          AND t.state IN ('delegated_pending','cancelled','committing','publish_queued','publish_failed','published')
          AND o.delivery_attempts<8 AND ((o.delivery_state='pending' AND o.next_attempt_at<=clock_timestamp()) OR
            (o.delivery_state='leased' AND o.lease_until<=clock_timestamp()))
          ORDER BY o.next_attempt_at,o.created_at,o.task_id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,[issuer,audience])).rows[0];
        if(!row)return null;
        const receipt={schemaVersion:1,entryRequestId:row.entry_request_id,candidateRevision:row.candidate_revision,
          acceptanceEpoch:Number(row.authority_epoch),requestHash:row.request_hash,sourceSnapshotHash:row.candidate_hash,
          requestBytes:row.request_bytes===null?null:Number(row.request_bytes),delegationId:row.delegation_id,
          idempotencyKey:row.request_key,taskId:row.task_id,eventId:row.event_id};
        if(!validPublicationReceipt(receipt)) {
          await c.query(`UPDATE publication_delegation_outbox SET delivery_state='blocked',last_code='evidence_missing',lease_token=NULL,lease_until=NULL
            WHERE task_id=$1`,[row.task_id]);
          return null;
        }
        const token=randomUUID();
        await c.query(`UPDATE publication_delegation_outbox SET delivery_state='leased',delivery_attempts=delivery_attempts+1,
          lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',last_code=NULL WHERE task_id=$1`,[row.task_id,token]);
        return Object.freeze({receipt:Object.freeze(receipt),token});
      });
    },
    async finish(lease,result) {
      if(!lease?.token||!validPublicationReceipt(lease.receipt)||!['delivered','retry','conflict'].includes(result?.kind)||
        (result.kind==='delivered'&&typeof result.localIntentCancelled!=='boolean'))throw new PublicationReceiptError('invalid');
      return tx(async c=>{
        const row=(await c.query(`SELECT o.delivery_attempts FROM publication_delegation_outbox o JOIN publication_delegations d USING(task_id)
          WHERE o.task_id=$1 AND o.event_id=$2 AND o.lease_token=$3 AND o.delivery_state='leased' AND o.lease_until>clock_timestamp()
          AND d.issuer=$4 AND d.audience=$5 FOR UPDATE OF o`,[lease.receipt.taskId,lease.receipt.eventId,lease.token,issuer,audience])).rows[0];
        if(!row)return false;
        const delivered=result.kind==='delivered';
        const state=delivered?'delivered':result.kind==='conflict'?'blocked':row.delivery_attempts>=8?'exhausted':'pending';
        const code=delivered?null:result.kind==='conflict'?'conflict':state==='exhausted'?'exhausted':'unavailable';
        const backoff=Math.min(300,5*2**(row.delivery_attempts-1));
        const updated=await c.query(`UPDATE publication_delegation_outbox SET delivery_state=$4,last_code=$5,
          lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+($6::int*interval '1 second'),
          delivered_at=CASE WHEN $4='delivered' THEN clock_timestamp() ELSE NULL END,local_intent_cancelled=$7
          WHERE task_id=$1 AND event_id=$2 AND lease_token=$3 AND delivery_state='leased' AND lease_until>clock_timestamp()`,
        [lease.receipt.taskId,lease.receipt.eventId,lease.token,state,code,backoff,delivered?result.localIntentCancelled:null]);
        return updated.rowCount===1;
      });
    }
  });
}
