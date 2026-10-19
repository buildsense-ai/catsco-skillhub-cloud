import {setTimeout as delay} from 'node:timers/promises';
import {publicationTaskSettings} from '../publication-tasks/config.js';
import {processDelegatedPublicationCommit} from './commit-coordinator.js';

// One independent, bounded lane per worker process. SQL leases coordinate other
// processes; no in-memory queue, authorization, version reservation or retry
// budget lives here. A restart reclaims only due, durably permitted commits.
export function createDelegatedPublicationScheduler(config, {store,
  processCommit=processDelegatedPublicationCommit, warn=message=>console.warn(message)}={}) {
  let enabled=false;
  if(config.publicationDelegatedWorker?.enabled===true) {
    try {
      enabled=config.publicationPublishing?.enabled===true && Boolean(publicationTaskSettings(config)) &&
        typeof store?.query==='function' && typeof store?.tx==='function' &&
        Number.isSafeInteger(config.worker?.pollMs) && config.worker.pollMs>0 && config.worker.pollMs<=60000;
    } catch { /* Invalid optional configuration never enables claiming. */ }
    if(!enabled)warn('Delegated publication worker configuration is unavailable.');
  }
  let stopped=false,pending=null,running=null;
  const wake=new AbortController();
  const tick=()=>{
    if(!enabled || stopped)return Promise.resolve(null);
    if(pending)return pending;
    pending=Promise.resolve().then(()=>processCommit(config,{enabled:true,store})).catch(()=>{
      // Never print SQL, candidate content, paths, peer credentials or raw errors.
      warn('Delegated publication processing is unavailable.');
      return null;
    }).finally(()=>{pending=null;});
    return pending;
  };
  return Object.freeze({
    enabled,tick,
    run({once=false}={}) {
      if(running)return running;
      running=(async()=>{
        try {
          while(enabled && !stopped) {
            const result=await tick();
            if(once && !result)return;
            if(!result && !stopped)await delay(config.worker.pollMs,undefined,{signal:wake.signal});
          }
        } catch(error) {
          if(error.name!=='AbortError')throw error;
        } finally {stopped=true;}
      })();
      return running;
    },
    async stop() {
      stopped=true;wake.abort();
      // Graceful stop finishes the current fenced attempt, but admits no next
      // task. Forced termination is recovered by the durable lease on restart.
      await pending;
      await running;
    }
  });
}
