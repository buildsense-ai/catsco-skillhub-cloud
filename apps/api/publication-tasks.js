import { createHash } from 'node:crypto';
import { getActorFromRequest, RateLimiter } from '../../packages/auth/index.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import { taskError } from '../../packages/publication-tasks/store.js';
import { runPublishValidation } from '../../packages/publish-validation/runner.js';
import { readRaw, withAbort } from './publish-validation.js';

export function createPublicationTasksHandler(config, store) {
  let settings, limiter;
  try {
    settings = publicationTaskSettings(config);
    if (settings) limiter = new RateLimiter({ limit: settings.execution.requestsPerMinute, windowMs: 60000, maxBuckets: 20000 });
  } catch { settings = null; }
  let active = 0;
  return async ({ req, res, pathname, sendJson }) => {
    const root = '/api/skills/publication-tasks';
    if (pathname !== root && !pathname.startsWith(root + '/')) return false;
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) res.setHeader('Connection', 'close');
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, status, body);
    };
    if (!config.publicationTasks?.enabled) { reply(404, { error: { code: 'not_found', message: 'Publication tasks are disabled.' } }); return true; }
    if (!settings) { reply(503, { error: { code: 'skillhub.publication_task_unavailable', message: 'Publication tasks are unavailable.' } }); return true; }
    if (active >= settings.execution.maxConcurrent) { reply(503, { error: { code: 'skillhub.publication_task_busy', message: 'Publication tasks are busy.' } }); return true; }
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    const timer = setTimeout(abort, settings.execution.readTimeoutMs + settings.execution.workerTimeoutMs);
    const work = (async () => {
      // This authenticates a Cloud account, not a Bot or a delegated conversation.
      const actor = await getActorFromRequest(config, store, req, { allowAgent: false });
      if (!actor?.userId) throw taskError(403, 'account_required', 'An authenticated account is required.');
      if (controller.signal.aborted) throw taskError(503, 'unavailable', 'Publication task request timed out.');
      if (!limiter.check(actor.userId)) throw taskError(429, 'rate_limited', 'Publication task requests are too frequent.');
      const match = pathname.match(/^\/api\/skills\/publication-tasks\/(pubtask_[0-9a-f-]{36})(\/cancel)?$/);
      if (pathname === root && req.method === 'GET') return { status: 200, body: { tasks: await store.listPublicationTasks(actor.userId) } };
      if (match && ((req.method === 'GET' && !match[2]) || (req.method === 'POST' && match[2]))) {
        const task = match[2] ? await store.cancelPublicationTask(actor.userId, match[1]) : await store.getPublicationTask(actor.userId, match[1]);
        if (!task) throw taskError(404, 'not_found', 'Publication task was not found.');
        return { status: 200, body: { task } };
      }
      if (pathname !== root || req.method !== 'POST') throw taskError(404, 'not_found', 'Publication task route was not found.');
      const requestKey = req.headers['idempotency-key'];
      if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) throw taskError(400, 'key_invalid', 'Provide an 8-128 character Idempotency-Key.');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw taskError(400, 'body_invalid', 'Content-Type must be application/json.');
      const declared = req.headers['content-length'];
      if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > settings.limits.maxRequestBytes)) throw taskError(413, 'too_large', 'Request exceeds the byte limit.');
      const raw = await readRaw(req, settings.limits.maxRequestBytes, controller.signal);
      const requestHash = createHash('sha256').update(raw).digest('hex');
      const previous = await store.findPublicationTaskForRequest(actor.userId, requestKey, requestHash);
      if (previous) return { status: 200, body: { task: previous, replayed: true } };
      const result = await runPublishValidation(raw, settings.limits, {
        timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb, signal: controller.signal
      });
      if (![200,422].includes(result.status)) return result;
      if (controller.signal.aborted) throw taskError(503, 'unavailable', 'Publication task request timed out.');
      const report = result.body.validation ?? result.body.error?.validation;
      // Dangerous/un-decodable materials retain only their bounded rejection report.
      const candidate = report?.coverage === 'complete' && report.candidateHash ? raw : null;
      const saved = await store.createPublicationTask({ ownerId: actor.userId, requestKey,
        requestHash, candidateHash: report?.candidateHash ?? null,
        candidate, result, settings });
      return { status: saved.created ? (saved.task.state === 'queued' ? 202 : 201) : 200, body: { task: saved.task, replayed: !saved.created } };
    })();
    // Database operations cannot be cancelled safely. Retain admission until the
    // real work settles, even when HTTP times out or the client disconnects.
    work.then(() => { active--; }, () => { active--; });
    try {
      const result = await withAbort(work, controller.signal);
      reply(result.status, result.body);
    } catch (error) {
      const status = [400,401,403,404,409,413,429,503].includes(error.status) ? error.status : 503;
      const safe = typeof error.code === 'string' && error.code.startsWith('skillhub.publication_task_');
      reply(status, { error: { code: safe ? error.code : status === 401 || status === 403 ? 'auth_error' : 'skillhub.publication_task_unavailable',
        message: safe ? error.message : status === 401 || status === 403 ? 'Authentication is required.' : 'Publication task request could not complete.' } });
    } finally {
      clearTimeout(timer); req.off('aborted', abort); res.off('close', abort);
    }
    return true;
  };
}
