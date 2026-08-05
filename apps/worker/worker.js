import { pathToFileURL } from "node:url";
import { loadConfig } from "../../packages/config/index.js";
import { ensureRuntimeDirectories } from "../../packages/database/store.js";
import { processJobs, processNextJob } from "../../packages/queue/index.js";

export async function startWorker(config = loadConfig(), { once = false } = {}) {
  await ensureRuntimeDirectories(config);

  if (once) {
    const results = await processJobs(config);
    console.log(JSON.stringify({ processed: results.length, results: results.map((item) => ({ jobId: item.job.id, type: item.job.type, status: item.status })) }, null, 2));
    return results;
  }

  console.log(`CatsCo SkillHub worker started as ${config.worker.id}`);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  while (!stopped) {
    const result = await processNextJob(config);
    if (!result) await sleep(config.worker.pollMs);
  }
  console.log("CatsCo SkillHub worker stopped");
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

