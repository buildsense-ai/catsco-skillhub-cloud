import { pathToFileURL } from "node:url";
import { loadConfig } from "../../packages/config/index.js";
import { ensureRuntimeDirectories } from "../../packages/database/store.js";
import { processJobs, processNextJob } from "../../packages/queue/index.js";
import { createStore } from "../../packages/database/store.js";
import { processPublicationTask } from "../../packages/publication-tasks/worker.js";
import { processPublicationCommit } from '../../packages/publication-tasks/commit-worker.js';
import { publicationTaskSettings } from "../../packages/publication-tasks/config.js";
import { createDelegatedPublicationScheduler } from '../../packages/publication-delegation/commit-scheduler.js';
import { createPublicationReceiptDispatcher } from '../../packages/publication-delegation/receipt-worker.js';
import { createPublicationDescriptionReleaseScheduler } from '../../packages/publication-description-derivations/commit-scheduler.js';

// A Cloud acceptance receipt is historical evidence only. This lane never
// grants a commit permit and never changes publication state by itself.
export function createPublicationReceiptDelivery(config, store, dependencies = {}) {
  const settings = config?.publicationReceiptDelivery ?? {};
  return createPublicationReceiptDispatcher(
    { ...settings, store },
    {
      ...dependencies,
      pollIntervalMs: dependencies.pollIntervalMs ?? settings.pollMs
    }
  );
}

export async function startWorker(config = loadConfig(), { once = false } = {}) {
  await ensureRuntimeDirectories(config);
  const taskStore = createStore(config);
  const delegated = createDelegatedPublicationScheduler(config, {store: taskStore});
  const receiptDelivery = createPublicationReceiptDelivery(config, taskStore);
  const descriptionRelease = createPublicationDescriptionReleaseScheduler(config, { store: taskStore });
  if (once) await receiptDelivery.runOnce();
  else receiptDelivery.start();
  let tasksEnabled = false;
  try { tasksEnabled = Boolean(publicationTaskSettings(config)); } catch { /* optional feature fails closed */ }
  let lastTaskMaintenance = 0;
  const tickTasks = async () => {
    if (!tasksEnabled) return null;
    try {
      if (Date.now() - lastTaskMaintenance >= 60000) {
        await taskStore.maintainPublicationTasks();
        lastTaskMaintenance = Date.now();
      }
      const validated = await processPublicationTask(config, { store: taskStore });
      const published = await processPublicationCommit(config, { store: taskStore });
      return published ?? validated;
    } catch {
      // Optional task storage failure must not stop the legacy publishing worker.
      console.warn('Publication task processing is unavailable.');
      return null;
    }
  };

  let stopped = false;
  const stop = () => {
    stopped = true;
    void delegated.stop().catch(()=>{}); // also stop admission while legacy IO settles
    void receiptDelivery.stop().catch(()=>{});
    void descriptionRelease.stop().catch(()=>{});
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // Run independently: a slow permitted Git/package operation never blocks
  // the legacy lane. Its own SQL lease/retry limits survive process restarts.
  const delegatedRun=delegated.run({once});
  const descriptionReleaseRun=descriptionRelease.run({once});
  try {
    if (once) {
      const results = await processJobs(config);
      while (!stopped && await tickTasks()) { /* due work only; retries have backoff */ }
      await delegatedRun;
      await descriptionReleaseRun;
      console.log(JSON.stringify({ processed: results.length, results: results.map((item) => ({ jobId: item.job.id, type: item.job.type, status: item.status })) }, null, 2));
      return results;
    }
    console.log(`CatsCo SkillHub worker started as ${config.worker.id}`);
    while (!stopped) {
      const result = await processNextJob(config);
      const taskResult = await tickTasks();
      if (!result && !taskResult) await sleep(config.worker.pollMs);
    }
    console.log("CatsCo SkillHub worker stopped");
  } finally {
    await delegated.stop();
    await receiptDelivery.stop();
    await descriptionRelease.stop();
    process.removeListener('SIGTERM',stop);
    process.removeListener('SIGINT',stop);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker(loadConfig(), { once: process.argv.includes("--once") }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

