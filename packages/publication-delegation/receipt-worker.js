import { createPublicationReceiptClient, PublicationReceiptError, validReceiptPeerConfig } from './receipt-client.js';
import { createPublicationReceiptStore } from './receipt-store.js';

// No app/worker bootstrap or environment enablement. A future isolated rollout
// must explicitly construct and start this dispatcher with trusted peer config.
export function createPublicationReceiptDispatcher(config={},dependencies={}) {
  const enabled=config.enabled===true;
  if(enabled&&(!validReceiptPeerConfig(config)||!config.store?.tx))throw new PublicationReceiptError('configuration');
  const ledger=enabled?(dependencies.ledger??createPublicationReceiptStore(config.store,config)):null;
  const client=enabled?(dependencies.client??createPublicationReceiptClient(config)):null;
  const interval=enabled?(dependencies.pollIntervalMs??5000):5000; // trusted test dependency only
  if(!Number.isInteger(interval)||interval<10||interval>30000)throw new PublicationReceiptError('configuration');
  const shutdown=new AbortController(),inflight=new Set();
  let started=false,stopped=false,timer,lastErrorCode=null;
  async function process(signal) {
    if(signal.aborted)return null;
    const lease=await ledger.claim();
    if(!lease)return null;
    let outcome;
    try {
      if(signal.aborted)throw new PublicationReceiptError();
      const ack=await client.deliver(lease.receipt,{signal});
      // Keep the store boundary safe even with an injected peer adapter. A
      // receipt ACK is never interpreted as a commit or remote-cancel permit.
      if(ack?.schemaVersion!==1||ack.recorded!==true||ack.commitAllowed!==false||typeof ack.localIntentCancelled!=='boolean'||
        ack.entryRequestId!==lease.receipt.entryRequestId||ack.taskId!==lease.receipt.taskId||ack.eventId!==lease.receipt.eventId)
        throw new PublicationReceiptError();
      outcome={kind:'delivered',localIntentCancelled:ack.localIntentCancelled};
    } catch(error) {
      outcome={kind:error instanceof PublicationReceiptError&&error.code==='skillhub.publication_receipt_conflict'?'conflict':'retry'};
    }
    const settled=await ledger.finish(lease,outcome);
    // Scheduling evidence only. No source, owner, key, token, raw errors or ACK.
    return {eventId:lease.receipt.eventId,settled};
  }
  function runOnce({signal}={}) {
    if(!enabled||stopped||signal?.aborted)return Promise.resolve(null);
    if(inflight.size>=4)return Promise.resolve(null);
    const combined=signal?AbortSignal.any([shutdown.signal,signal]):shutdown.signal;
    const pending=process(combined).catch(()=>{throw new PublicationReceiptError('storage');});
    inflight.add(pending);
    pending.then(()=>inflight.delete(pending),()=>inflight.delete(pending));
    return pending;
  }
  async function sweep() {
    try{await runOnce();lastErrorCode=null;}catch{lastErrorCode='skillhub.publication_receipt_storage';}
    if(!stopped){timer=setTimeout(sweep,interval);timer.unref?.();}
  }
  return Object.freeze({runOnce,
    start(){if(!enabled||started||stopped)return;started=true;void sweep();},
    async stop(){stopped=true;clearTimeout(timer);shutdown.abort();await Promise.allSettled([...inflight]);},
    status(){return {started,stopped,inflight:inflight.size,lastErrorCode};}
  });
}
