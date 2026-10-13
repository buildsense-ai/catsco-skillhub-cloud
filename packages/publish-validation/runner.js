import { Worker } from "node:worker_threads";

export class ValidationExecutionError extends Error {
  constructor(code = "skillhub.publish_validation_unavailable") {
    super("Publication validation could not complete. Please retry.");
    this.code = code;
    this.status = 503;
  }
}

export async function runPublishValidation(rawJson, limits, {
  timeoutMs = 10000, memoryMb = 512, signal,
  workerUrl = new URL("./worker.js", import.meta.url)
} = {}) {
  if (signal?.aborted) throw new ValidationExecutionError();
  const worker = new Worker(workerUrl, {
    workerData: { rawJson, limits },
    resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(32, memoryMb), stackSizeMb: 4 }
  });
  let timer;
  let onAbort;
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new ValidationExecutionError());
      onAbort = fail;
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.once("message", resolve);
      worker.once("error", fail);
      worker.once("exit", fail);
      timer = setTimeout(fail, timeoutMs);
      if (signal?.aborted) fail();
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // Callers release their concurrency slot only once the worker is gone.
    await worker.terminate();
  }
}
