import { createHash } from 'node:crypto';
import { getActorFromRequest, RateLimiter } from '../../packages/auth/index.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import { taskError } from '../../packages/publication-tasks/store.js';
import { runPublishValidation } from '../../packages/publish-validation/runner.js';
import { readRaw, withAbort } from './publish-validation.js';
import { parseStrictJson } from '../../packages/publish-validation/index.js';

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
      if (config.publicationPublishing?.enabled) {
        for (const task of [body?.task,...(body?.tasks ?? [])].filter(Boolean)) {
          task.capabilities={...task.capabilities,publish:['ready','publish_failed'].includes(task.state)};
        }
      }
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
      const publishMatch = pathname.match(/^\/api\/skills\/publication-tasks\/(pubtask_[0-9a-f-]{36})\/publish$/);
      if (publishMatch && req.method==='POST' && config.publicationPublishing?.enabled) {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw taskError(400,'body_invalid','Content-Type must be application/json.');
        const length=req.headers['content-length'];
        if (length!=null && (!/^\d+$/.test(length) || Number(length)>4096)) throw taskError(413,'too_large','Publication request exceeds the byte limit.');
        const publishRaw=await readRaw(req,4096,controller.signal);
        let input;
        try { input=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(publishRaw)); }
        catch { throw taskError(400,'body_invalid','Invalid publication request.'); }
        if (!input || typeof input!=='object' || Array.isArray(input) ||
          Object.keys(input).some(k=>!['candidateHash','confirmVersionPublish'].includes(k)) ||
          !/^[a-f0-9]{64}$/.test(input.candidateHash ?? '') || typeof input.confirmVersionPublish!=='boolean') {
          throw taskError(400,'body_invalid','Provide candidateHash and an explicit confirmVersionPublish boolean.');
        }
        const row=await store.getPublicationRequest(actor.userId,publishMatch[1]);
        if (!row) throw taskError(404,'not_found','Publication task was not found.');
        if (row.candidate_hash!==input.candidateHash) throw taskError(409,'candidate_changed','Publication candidate changed.');
        let manifest;
        if (!row.intent) {
          if (row.state!=='ready' || !row.candidate || !row.candidate_live) throw taskError(409,'not_ready','Only a live, validated candidate can be published.');
          if (!actor.developerProfile?.id || !actor.developerProfile.namespace) throw taskError(403,'publisher_changed','Publisher identity is unavailable.');
          const derived=await runPublishValidation({candidate:row.candidate,requestHash:row.request_hash,
            candidateHash:row.candidate_hash,namespace:actor.developerProfile.namespace},settings.limits,{
            timeoutMs:settings.execution.workerTimeoutMs,memoryMb:settings.execution.workerMemoryMb,signal:controller.signal,
            workerUrl:new URL('../../packages/publication-tasks/draft-worker.js',import.meta.url)});
          if (derived.status!==200) return derived;
          manifest=derived.manifest;
        }
        if (controller.signal.aborted) throw taskError(503,'unavailable','Publication request timed out.');
        const accepted=await store.enqueuePublicationCommit({ownerId:actor.userId,id:row.id,
          candidateHash:input.candidateHash,confirmVersionPublish:input.confirmVersionPublish,
          manifest,profile:actor.developerProfile});
        return {status:['publish_queued','publishing','committing'].includes(accepted.task.state)?202:200,body:accepted};
      }
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
      // Shared HTTP helpers speak P1's namespace. Map only known transport
      // failures and use static messages, never forward an arbitrary exception.
      if (error.status === 413 && error.code === 'skillhub.publish_validation_request_too_large') {
        error = taskError(413, 'too_large', 'Request exceeds the byte limit.');
      } else if (error.status === 400 && error.code === 'skillhub.publish_validation_invalid_request') {
        error = taskError(400, 'body_invalid', 'Request could not be read.');
      } else if (error.status === 503 && error.code === 'skillhub.publish_validation_unavailable') {
        error = taskError(503, 'unavailable', 'Publication task request could not complete.');
      }
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
