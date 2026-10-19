import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { RateLimiter } from '../../packages/auth/index.js';
import { parseStrictJson } from '../../packages/publish-validation/index.js';
import { createDelegatedPublicationControlStore, PublicationControlError } from '../../packages/publication-delegation/control-store.js';
import { validReceiptPeerConfig, validPublicationReceipt } from '../../packages/publication-delegation/receipt-client.js';
import { readRaw, withAbort } from './publish-validation.js';

export const PUBLICATION_CONTROL_PATH = '/api/skills/publication-delegations/control';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const cancellationID = v => typeof v === 'string' && /^pubcancel_[a-f0-9]{32}$/.exec(v)?.[0] === v;
const header = (req, name) => {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  }
  if (values.length > 1) throw new Error('duplicate header');
  return values[0];
};

// A dedicated service credential authenticates CatsCo, not the human publisher.
// CatsCo must commit its authorized cancellation intent BEFORE sending cancel.
// Read likewise requires CatsCo's original-human historical-read check.
export function createPublicationControlHandler(config, store, dependencies = {}) {
  const settings = config.publicationControl ?? {};
  const enabled = settings.enabled === true;
  let control, peerHost, secret, proxies;
  const limiter = new RateLimiter({ limit: 120, windowMs: 60000, maxBuckets: 1 });
  const budget = dependencies.timeoutMs ?? 5000; // test injection, never caller input
  try {
    if (enabled) {
      if (!validReceiptPeerConfig(settings) || !Number.isInteger(budget) || budget < 1 || budget > 5000 ||
          !Array.isArray(settings.trustedProxyAddresses) || settings.trustedProxyAddresses.some(ip => !isIP(ip)) ||
          [config.agent?.clientSecret, config.session?.secret, config.mutationWriter?.secret].includes(settings.peerSecret)) throw new Error();
      peerHost = new URL(settings.audience).host;
      secret = Buffer.from(`Bearer ${settings.peerSecret}`);
      proxies = new Set(settings.trustedProxyAddresses);
      control = dependencies.control ?? createDelegatedPublicationControlStore({ ...settings, store });
    }
  } catch { control = null; }
  let active = 0;
  return async (req, res) => {
    // Reserve the namespace before generic account auth, CORS and URL decoding.
    if (!req.url?.startsWith('/api/skills/publication-delegations/')) return false;
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const fail = (status, kind) => reply(status, { error: {
      code: `skillhub.publication_control_${kind}`,
      message: new PublicationControlError(kind).message
    } });
    if (!enabled || req.url !== PUBLICATION_CONTROL_PATH) { fail(404, 'disabled'); return true; }
    if (!control) { fail(503, 'configuration'); return true; }
    if (req.method !== 'POST') { fail(405, 'invalid'); return true; }
    try {
      const proxyTLS = proxies.has(req.socket.remoteAddress) && header(req, 'x-forwarded-proto') === 'https';
      if ((!req.socket.encrypted && !proxyTLS) || header(req, 'host') !== peerHost ||
          header(req, 'origin') !== undefined || header(req, 'cookie') !== undefined) throw new Error();
      const supplied = Buffer.from(header(req, 'authorization') ?? '');
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) throw new Error();
    } catch { fail(401, 'unauthorized'); return true; }
    if (!limiter.check('catsco-peer')) { fail(429, 'busy'); return true; }
    if (active >= 16) { fail(503, 'busy'); return true; }
    active++;
    const controller = new AbortController(), abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    const timer = setTimeout(abort, budget);
    // Keep admission occupied until SQL actually settles even after timeout or
    // lost response. An HTTP timeout does not prove cancellation rolled back.
    const work = (async () => {
      const length = header(req, 'content-length');
      if (header(req, 'content-encoding') !== undefined ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(req, 'content-type') ?? '') ||
          (length !== undefined && (!/^[1-9][0-9]{0,3}$/.test(length) || Number(length) > 4096))) {
        throw new PublicationControlError('invalid');
      }
      let input;
      try {
        const raw = await readRaw(req, 4096, controller.signal);
        input = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw), { maxDepth: 5, maxNodes: 80 });
      } catch { throw new PublicationControlError(controller.signal.aborted ? 'storage' : 'invalid'); }
      const keys = input?.action === 'cancel' ? ['schemaVersion', 'action', 'receipt', 'cancellationId'] : ['schemaVersion', 'action', 'receipt'];
      if (!exact(input, keys) || input.schemaVersion !== 1 || !['read', 'cancel'].includes(input.action) ||
          !validPublicationReceipt(input.receipt) || (input.action === 'cancel' && !cancellationID(input.cancellationId))) throw new PublicationControlError('invalid');
      if (controller.signal.aborted) throw new PublicationControlError('storage');
      const observation = await control[input.action](input.receipt);
      return { ...observation, action: input.action, eventId: input.receipt.eventId,
        cancellationId: input.action === 'cancel' ? input.cancellationId : null };
    })();
    work.then(() => { active--; }, () => { active--; });
    try { reply(200, await withAbort(work, controller.signal)); }
    catch (error) {
      const kind = error instanceof PublicationControlError ? error.code.replace('skillhub.publication_control_', '') : 'storage';
      fail(({ invalid: 400, not_found: 404, conflict: 409 })[kind] ?? 503, kind);
    } finally {
      clearTimeout(timer); req.off('aborted', abort); res.off('close', abort);
    }
    return true;
  };
}
