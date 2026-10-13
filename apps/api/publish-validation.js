import { getActorFromRequest, RateLimiter } from "../../packages/auth/index.js";
import { describeRules } from "../../packages/publish-validation/index.js";
import { runPublishValidation } from "../../packages/publish-validation/runner.js";

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function readRaw(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const clean = () => {
      req.off("data", onData); req.off("end", onEnd); req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error) => { clean(); req.pause(); reject(error); };
    const onError = () => fail(failure(400, "skillhub.publish_validation_invalid_request", "Request could not be read."));
    const onAbort = () => fail(failure(503, "skillhub.publish_validation_unavailable", "Publication validation timed out. Please retry."));
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) return fail(failure(413, "skillhub.publish_validation_request_too_large", "Request exceeds the byte limit."));
      chunks.push(chunk);
    };
    const onEnd = () => { clean(); resolve(Buffer.concat(chunks)); };
    req.on("data", onData); req.once("end", onEnd); req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(503, "skillhub.publish_validation_unavailable", "Publication validation timed out. Please retry."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function createPublishValidationHandler(config, store) {
  const settings = config.publishValidation;
  let limiter;
  let rules;
  if (settings.enabled) {
    try {
      const execution = {
        maxConcurrent: settings.maxConcurrent,
        requestsPerMinute: settings.requestsPerMinute,
        readTimeoutMs: settings.readTimeoutMs,
        workerTimeoutMs: settings.workerTimeoutMs,
        workerMemoryMb: settings.workerMemoryMb
      };
      if (Object.values(execution).some(value => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error("Invalid publication validation configuration");
      }
      rules = { ...describeRules({ ...config.limits, ...settings.limits }), execution };
      limiter = new RateLimiter({ limit: settings.requestsPerMinute, windowMs: 60000, maxBuckets: 20000 });
    } catch {
      // Fail closed for this optional feature only. Do not expose/log raw
      // settings, replace invalid budgets with defaults, or crash API startup.
      rules = null;
    }
  }
  let active = 0;
  return async ({ req, res, pathname, sendJson }) => {
    const isRules = req.method === "GET" && pathname === "/api/skills/publish-validation/rules";
    const isValidate = req.method === "POST" && pathname === "/api/skills/publish-validation";
    if (!isRules && !isValidate) return false;
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) res.setHeader("Connection", "close");
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, status, body);
    };
    if (!settings.enabled) {
      reply(404, { error: { code: "not_found", message: "Publication validation is disabled." } });
      return true;
    }
    if (!rules) {
      reply(503, { error: { code: "skillhub.publish_validation_unavailable", message: "Publication validation is unavailable." } });
      return true;
    }
    if (active >= settings.maxConcurrent) {
      reply(503, { error: { code: "skillhub.publish_validation_busy", message: "Publication validation is busy. Please retry." } });
      return true;
    }
    active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    // Starts before authentication: no unlimited idle/authenticated body reads.
    const timer = setTimeout(abort, settings.readTimeoutMs);
    let authPromise;
    let authSettled = true;
    try {
      const declared = req.headers["content-length"];
      if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > rules.limits.maxRequestBytes)) {
        throw failure(413, "skillhub.publish_validation_request_too_large", "Request exceeds the byte limit.");
      }
      authSettled = false;
      authPromise = getActorFromRequest(config, store, req, { allowAgent: true });
      // Authentication uses the existing store API, which cannot cancel an
      // in-flight query. Track its real settlement, not just the HTTP timeout.
      authPromise.then(() => { authSettled = true; }, () => { authSettled = true; });
      const actor = await withAbort(authPromise, controller.signal);
      if (!limiter.check(actor.userId ?? actor.id)) throw failure(429, "rate_limited", "Publication validation requests are too frequent.");
      if (isRules) {
        reply(200, rules);
      } else {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
          throw failure(400, "skillhub.publish_validation_invalid_request", "Content-Type must be application/json.");
        }
        const raw = await readRaw(req, rules.limits.maxRequestBytes, controller.signal);
        clearTimeout(timer);
        const result = await runPublishValidation(raw, rules.limits, {
          timeoutMs: settings.workerTimeoutMs, memoryMb: settings.workerMemoryMb, signal: controller.signal
        });
        reply(result.status, result.body);
      }
    } catch (error) {
      const status = [400, 401, 403, 413, 429, 503].includes(error.status) ? error.status : 503;
      const known = typeof error.code === "string" && (error.code.startsWith("skillhub.publish_validation_") || error.code === "rate_limited");
      reply(status, { error: {
        code: known ? error.code : status === 401 || status === 403 ? "auth_error" : "skillhub.publish_validation_unavailable",
        message: known ? error.message : status === 401 || status === 403 ? "Authentication is required." : "Publication validation could not complete. Please retry."
      } });
    } finally {
      clearTimeout(timer);
      req.off("aborted", abort); res.off("close", abort);
      if (!authSettled && authPromise) {
        // Reply/close promptly but do not let repeated disconnects bypass the
        // admission cap while their database authentication is still running.
        authPromise.then(() => { active -= 1; }, () => { active -= 1; });
      } else {
        active -= 1;
      }
    }
    return true;
  };
}
