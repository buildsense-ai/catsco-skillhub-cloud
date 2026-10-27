import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { RateLimiter } from '../../packages/auth/index.js';
import { parseStrictJson } from '../../packages/publish-validation/index.js';
import { runDerivePublicationDescription } from '../../packages/publication-tasks/description-derivation.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import { exactProposal, proposalDigest, PublicationDescriptionDerivationError } from '../../packages/publication-description-derivations/store.js';
import { readRaw, withAbort } from './publish-validation.js';
import { readPublicationDescriptionCopy, validatePublicationDescriptionCopy } from '../../packages/publication-description-derivations/read.js';
import { createPublicationDescriptionReleasePlanner } from '../../packages/publication-description-derivations/release-plan.js';
import { createPublicationDescriptionReleasePermitClient } from '../../packages/publication-description-derivations/release-permit-client.js';
import { validRequest as validCommitAdmissionRequest, PublicationDescriptionCommitAdmissionError } from '../../packages/publication-description-derivations/commit-admission.js';

export const PUBLICATION_DESCRIPTION_DERIVATION_PATH = '/api/skills/publication-descriptions/internal/derive';
export const PUBLICATION_DESCRIPTION_READ_PATH = '/api/skills/publication-descriptions/internal/read';
export const PUBLICATION_DESCRIPTION_VALIDATE_PATH = '/api/skills/publication-descriptions/internal/validate';
export const PUBLICATION_DESCRIPTION_PLAN_PATH = '/api/skills/publication-descriptions/internal/plan';
export const PUBLICATION_DESCRIPTION_AUTHORIZE_PATH = '/api/skills/publication-descriptions/internal/authorize';
export const PUBLICATION_DESCRIPTION_COMMIT_PATH = '/api/skills/publication-descriptions/internal/commit';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const application = value => typeof value === 'string' && /^pubdesc_[a-f0-9]{64}$/.test(value);
const task = value => typeof value === 'string' && /^pubtask_[0-9a-f-]{36}$/.test(value);
const httpsOrigin = value => {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password; }
  catch { return false; }
};
const header = (req, name) => {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  if (values.length > 1) throw Error('duplicate header');
  return values[0];
};

// Trusted, service-to-service adapter only. It is intentionally not an
// account/browser endpoint and remains disabled until the CatsCo adapter is
// deployed with a dedicated credential.
export function createPublicationDescriptionDerivationHandler(config, store, dependencies = {}) {
  const settings = config.publicationDescriptionDerivation ?? {};
  const enabled = settings.enabled === true;
  const limiter = new RateLimiter({ limit: 60, windowMs: 60000, maxBuckets: 1 });
  const budget = dependencies.timeoutMs ?? settings.timeoutMs ?? 30000;
  let secret, hosts, proxies, planner, releaseAuthorizer, releasePermitConfigurationError = false;
  try {
    if (enabled) {
      if (!Number.isInteger(budget) || budget < 1000 || budget > 60000 ||
        typeof settings.peerSecret !== 'string' || !/^pubderive_[a-f0-9]{64}$/.test(settings.peerSecret) ||
        !httpsOrigin(settings.issuer) || !httpsOrigin(settings.audience) ||
        !Array.isArray(settings.trustedProxyAddresses) || settings.trustedProxyAddresses.some(ip => !isIP(ip))) throw Error();
      const audience = new URL(settings.audience);
      hosts = new Set([audience.host, ...(!audience.port ? [audience.hostname + ':443'] : [])]);
      proxies = new Set(settings.trustedProxyAddresses);
      secret = Buffer.from(`Bearer ${settings.peerSecret}`);
      if (settings.planEnabled === true) planner = createPublicationDescriptionReleasePlanner({ enabled: true, config, store,
        issuer: settings.issuer, audience: settings.audience });
    }
  } catch { secret = null; }
  if (enabled && settings.releasePermit?.enabled === true) {
    try {
      if (settings.planEnabled !== true) throw Error();
      const peer = dependencies.releasePermitClient
        ?? createPublicationDescriptionReleasePermitClient({ ...settings.releasePermit, enabled: true });
      releaseAuthorizer = createPublicationDescriptionReleasePlanner({ enabled: true, releasePermitEnabled: true, config, store,
        issuer: settings.issuer, audience: settings.audience, permitClient: peer });
    } catch { releasePermitConfigurationError = true; }
  }
  let active = 0;
  return async (req, res) => {
    if (!req.url?.startsWith(PUBLICATION_DESCRIPTION_DERIVATION_PATH)
      && !req.url?.startsWith(PUBLICATION_DESCRIPTION_READ_PATH)
      && !req.url?.startsWith(PUBLICATION_DESCRIPTION_VALIDATE_PATH)
      && !req.url?.startsWith(PUBLICATION_DESCRIPTION_PLAN_PATH)
      && !req.url?.startsWith(PUBLICATION_DESCRIPTION_AUTHORIZE_PATH)
      && !req.url?.startsWith(PUBLICATION_DESCRIPTION_COMMIT_PATH)) return false;
    const reading = req.url === PUBLICATION_DESCRIPTION_READ_PATH;
    const validating = req.url === PUBLICATION_DESCRIPTION_VALIDATE_PATH;
    const planning = req.url === PUBLICATION_DESCRIPTION_PLAN_PATH;
    const authorizing = req.url === PUBLICATION_DESCRIPTION_AUTHORIZE_PATH;
    const committing = req.url === PUBLICATION_DESCRIPTION_COMMIT_PATH;
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) res.setHeader('Connection', 'close');
      if (reading && status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(body);
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const fail = (status, kind) => reply(status, { error: {
      code: `skillhub.publication_description_derivation_${kind}`,
      message: 'Description derivation could not be completed.'
    } });
    if (!enabled || (req.url !== PUBLICATION_DESCRIPTION_DERIVATION_PATH && !reading && !validating && !planning && !authorizing && !committing)
      || (reading && settings.readEnabled !== true)
      || (validating && settings.validationEnabled !== true)
      || (planning && settings.planEnabled !== true)
      || (authorizing && settings.releasePermit?.enabled !== true)
      || (committing && settings.commitAdmissionEnabled !== true)) { fail(404, 'disabled'); return true; }
    if (!secret) { fail(503, 'configuration'); return true; }
    if (authorizing && (!releaseAuthorizer || releasePermitConfigurationError)) { fail(503, 'configuration'); return true; }
    if (req.method !== 'POST') { fail(405, 'invalid'); return true; }
    try {
      const proxy = proxies.has(req.socket.remoteAddress) && header(req, 'x-forwarded-proto') === 'https';
      if ((!req.socket.encrypted && !proxy) || !hosts.has(header(req, 'host')) ||
        header(req, 'origin') !== undefined || header(req, 'cookie') !== undefined) throw Error();
      const supplied = Buffer.from(header(req, 'authorization') ?? '');
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) throw Error();
    } catch { fail(401, 'unauthorized'); return true; }
    if (!limiter.check('catsco-peer')) { fail(429, 'busy'); return true; }
    if (active >= 2) { fail(503, 'busy'); return true; }
    active++;
    const controller = new AbortController(), abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    const responseDone = new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); });
    const timer = setTimeout(() => {
      abort();
      if (res.headersSent && !res.writableFinished) res.destroy();
    }, budget);
    const work = (async () => {
      const length = header(req, 'content-length');
      if (header(req, 'content-encoding') !== undefined ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(req, 'content-type') ?? '') ||
        (length !== undefined && (!/^\d{1,6}$/.test(length) || Number(length) > 32768))) throw new PublicationDescriptionDerivationError('invalid', 400);
      let input;
      try { input = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readRaw(req, 32768, controller.signal)), { maxDepth: 8, maxNodes: 150 }); }
      catch { throw new PublicationDescriptionDerivationError(controller.signal.aborted ? 'unavailable' : 'invalid', controller.signal.aborted ? 503 : 400); }
      if (committing) {
        if (typeof store.admit !== 'function') throw new PublicationDescriptionDerivationError('configuration', 503);
        if (!validCommitAdmissionRequest(input)) throw new PublicationDescriptionDerivationError('invalid', 400);
        let admitted;
        try { admitted = await store.admit(input); }
        catch (error) {
          if (!(error instanceof PublicationDescriptionCommitAdmissionError)) throw error;
          const kind = error.code.replace('skillhub.publication_description_release_commit_', '');
          throw new PublicationDescriptionDerivationError(kind, ({ invalid: 400, conflict: 409, storage_limit: 429,
            disabled: 404, busy: 503, unavailable: 503, configuration: 503 }[kind] ?? 503));
        }
        if (!admitted || !task(admitted.task_id) || !/^pubdescpermit_[a-f0-9]{32}$/.test(admitted.permit_id) ||
          !['queued', 'publishing', 'committing', 'published', 'publish_failed'].includes(admitted.state)) {
          throw new PublicationDescriptionDerivationError('conflict', 409);
        }
        return { schemaVersion: 1, applicationId: input.applicationId, taskId: admitted.task_id,
          permitId: admitted.permit_id, state: admitted.state, replayed: admitted.replayed === true };
      }
      if (planning) {
        if (!planner) throw new PublicationDescriptionDerivationError('configuration', 503);
        return planner.plan(input, { signal: controller.signal });
      }
      if (authorizing) return releaseAuthorizer.authorize(input, { signal: controller.signal });
      if (reading || validating) {
        const taskSettings = publicationTaskSettings(config);
        if (!taskSettings) throw new PublicationDescriptionDerivationError('configuration', 503);
        const inspect = validating ? validatePublicationDescriptionCopy : readPublicationDescriptionCopy;
        return inspect(store, input, taskSettings.limits,
          { timeoutMs: Math.min(20000, budget), memoryMb: taskSettings.execution.workerMemoryMb, signal: controller.signal });
      }
      if (!exact(input, ['schemaVersion', 'applicationId', 'taskId', 'requestHash', 'candidateHash', 'proposal']) ||
        input.schemaVersion !== 1 || !application(input.applicationId) || !task(input.taskId) ||
        !hash(input.requestHash) || !hash(input.candidateHash) || !exactProposal(input.proposal)) throw new PublicationDescriptionDerivationError('invalid', 400);
      if (controller.signal.aborted) throw new PublicationDescriptionDerivationError('unavailable', 503);
      const expectedProposalDigest = proposalDigest(input.proposal);
      const existing = await store.getPublicationDescriptionDerivation(input.applicationId);
      if (existing) {
        if (existing.task_id !== input.taskId || existing.request_hash !== input.requestHash || existing.candidate_hash !== input.candidateHash ||
          existing.proposal_digest !== expectedProposalDigest) throw new PublicationDescriptionDerivationError('conflict');
        return { applicationId: existing.application_id, taskId: existing.task_id, derivedBytes: Number(existing.derived_bytes), derivedRequestHash: existing.derived_request_hash,
          derivedCandidateHash: existing.derived_candidate_hash, receipt: existing.derivation_receipt, replayed: true };
      }
      const source = await store.getPublicationDescriptionDerivationSource(input.taskId);
      if (!source || source.authority_kind !== 'catsco' || !source.candidate || source.request_hash !== input.requestHash || source.candidate_hash !== input.candidateHash ||
        Number(source.candidate_bytes) !== source.candidate.length || source.state !== 'delegated_pending' || source.commit_started !== false ||
        !Number.isFinite(new Date(source.expires_at).getTime()) || new Date(source.expires_at).getTime() <= Date.now()) throw new PublicationDescriptionDerivationError('source_unavailable', 409);
      const validation = source.validation_result ?? source.intake_result;
      const taskSettings = publicationTaskSettings(config);
      if (!taskSettings) throw new PublicationDescriptionDerivationError('configuration', 503);
      const result = await runDerivePublicationDescription({ rawJson: source.candidate.toString('utf8'), requestHash: input.requestHash,
        candidateHash: input.candidateHash, validation: validation?.body?.validation ?? validation?.body?.error?.validation,
        proposal: input.proposal }, taskSettings?.limits ?? {}, { timeoutMs: Math.min(20000, budget), signal: controller.signal });
      if (result.status !== 200) {
        const code = result.body?.error?.code ?? '';
        const kind = code.endsWith('_context_invalid') ? 'invalid'
          : code.endsWith('_manual_review_required') ? 'manual_review_required'
            : code.endsWith('_report_changed') ? 'report_changed'
              : code.endsWith('_candidate_changed') ? 'candidate_changed' : 'unavailable';
        throw new PublicationDescriptionDerivationError(kind, result.status);
      }
      if (result.derived.receipt.proposalDigest !== expectedProposalDigest) throw new PublicationDescriptionDerivationError('receipt_mismatch', 409);
      const row = await store.retainPublicationDescriptionDerivation({ applicationId: input.applicationId, taskId: input.taskId, proposal: input.proposal, derived: result.derived });
      return { applicationId: row.application_id, taskId: row.task_id, derivedBytes: Number(row.derived_bytes), derivedRequestHash: row.derived_request_hash,
        derivedCandidateHash: row.derived_candidate_hash, receipt: row.derivation_receipt, replayed: false };
    })();
    // A large private response keeps its slot until both SQL/worker work and
    // response transmission settle. Disconnects cannot free a still-busy slot.
    void Promise.allSettled([work, responseDone]).then(() => {
      active--; clearTimeout(timer); req.off('aborted', abort); res.off('close', abort);
    });
    try { reply(200, await withAbort(work, controller.signal)); }
    catch (error) { const kind = error instanceof PublicationDescriptionDerivationError ? error.code.replace('skillhub.publication_description_derivation_', '') : 'unavailable';
      fail(error.status ?? ({ invalid: 400, conflict: 409, source_unavailable: 409 }[kind] ?? 503), kind); }
    return true;
  };
}
