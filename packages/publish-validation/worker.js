import { parentPort, workerData } from "node:worker_threads";
import { validatePublishRequest } from "./index.js";

// All untrusted JSON, YAML and ZIP parsing stays off the HTTP event loop.
try {
  let rawJson;
  try {
    rawJson = typeof workerData.rawJson === "string" ? workerData.rawJson
      : new TextDecoder("utf-8", { fatal: true }).decode(workerData.rawJson);
  } catch {
    parentPort.postMessage({ status: 400, body: { error: {
      code: "skillhub.publish_validation_invalid_request", message: "Request must contain valid UTF-8 JSON."
    } } });
    process.exit(0);
  }
  parentPort.postMessage(validatePublishRequest(rawJson, workerData.limits));
} catch {
  parentPort.postMessage({ status: 503, body: { error: {
    code: "skillhub.publish_validation_unavailable", message: "Publication validation could not complete. Please retry."
  } } });
}
