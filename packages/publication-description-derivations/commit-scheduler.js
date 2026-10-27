import { setTimeout as delay } from 'node:timers/promises';
import { publicationTaskSettings } from '../publication-tasks/config.js';
import { createPublicationDescriptionReleaseWorker } from './worker.js';
import { createPublicationDescriptionReleaseCommitWorker } from './commit-worker.js';

// Run the isolated derivation and completion stages without joining the
// legacy publication queue. SQL leases coordinate independent processes.
export function createPublicationDescriptionReleaseScheduler(config, { store,
  prepareWorker, commitWorker, warn = message => console.warn(message) } = {}) {
  let enabled = false;
  const flags = config?.publicationDescriptionDerivation ?? {};
  if (flags.enabled === true && flags.planEnabled === true && flags.commitWorkerEnabled === true) {
    try {
      enabled = config.publicationPublishing?.enabled === true && Boolean(publicationTaskSettings(config))
        && typeof store?.query === 'function' && typeof store?.tx === 'function'
        && Number.isSafeInteger(config.worker?.pollMs) && config.worker.pollMs > 0 && config.worker.pollMs <= 60000;
    } catch { /* Invalid optional configuration never enables claiming. */ }
    if (!enabled) warn('Description release worker configuration is unavailable.');
  }

  const prepare = prepareWorker ?? createPublicationDescriptionReleaseWorker({ enabled, config, store });
  const commit = commitWorker ?? createPublicationDescriptionReleaseCommitWorker({ enabled, config, store });
  let stopped = false, pending = null, running = null;
  const wake = new AbortController();
  const tick = () => {
    if (!enabled || stopped) return Promise.resolve(null);
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      const prepared = await prepare.once();
      const completed = await commit.once();
      return completed ?? prepared;
    }).catch(() => {
      warn('Description release processing is unavailable.');
      return null;
    }).finally(() => { pending = null; });
    return pending;
  };

  return Object.freeze({
    enabled,
    tick,
    run({ once = false } = {}) {
      if (running) return running;
      running = (async () => {
        try {
          while (enabled && !stopped) {
            const result = await tick();
            if (once && !result) return;
            if (!result && !stopped) await delay(config.worker.pollMs, undefined, { signal: wake.signal });
          }
        } catch (error) {
          if (error.name !== 'AbortError') throw error;
        } finally { stopped = true; }
      })();
      return running;
    },
    async stop() {
      stopped = true;
      wake.abort();
      await pending;
      await running;
    }
  });
}
