import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { RateLimiter } from '../../packages/auth/index.js';
import { parseStrictJson } from '../../packages/publish-validation/index.js';
import { validPublicationPeerOrigin } from '../../packages/publication-delegation/introspection.js';
import { createPublicationRepairMaterialReader, PublicationRepairMaterialError } from '../../packages/publication-delegation/repair-material.js';
import { readRaw, withAbort } from './publish-validation.js';

export const PUBLICATION_REPAIR_MATERIAL_PATH = '/api/skills/publication-repair/internal/material';
const header = (req, name) => {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  if (values.length > 1) throw new PublicationRepairMaterialError('invalid');
  return values[0];
};

// A dedicated, default-off peer lane, reserved BEFORE browser CORS/session
// routing. No upload grant/account/Bot token may substitute for its credential.
export function createPublicationRepairMaterialHandler(config, store) {
  const settings = config.publicationRepairMaterial ?? {}, enabled = settings.enabled === true;
  const limiter = new RateLimiter({ limit: 60, windowMs: 60000, maxBuckets: 1 });
  let reader, secret, hosts, proxies;
  try {
    if (enabled) {
      if (!validPublicationPeerOrigin(settings.issuer) || !validPublicationPeerOrigin(settings.audience)
        || settings.issuer === settings.audience || typeof settings.peerSecret !== 'string'
        || !/^pubmaterial_[a-f0-9]{64}$/.test(settings.peerSecret)
        || [config.agent?.clientSecret, config.session?.secret, config.mutationWriter?.secret,
          config.publicationUpload?.peerSecret, config.publicationCommitService?.peerSecret,
          config.publicationControl?.peerSecret, config.publicationDescriptionDerivation?.peerSecret].includes(settings.peerSecret)
        || !Array.isArray(settings.trustedProxyAddresses) || settings.trustedProxyAddresses.some(ip => !isIP(ip))) throw Error();
      const audience = new URL(settings.audience);
      hosts = new Set([audience.host, ...(!audience.port ? [audience.hostname + ':443'] : [])]);
      proxies = new Set(settings.trustedProxyAddresses);
      secret = Buffer.from(`Bearer ${settings.peerSecret}`);
      reader = createPublicationRepairMaterialReader({ ...settings, store });
    }
  } catch { reader = null; }
  let active = 0;
  return async (req, res) => {
    if (!req.url?.startsWith('/api/skills/publication-repair/')) return false;
    const fail = (status, kind) => {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: `skillhub.publication_repair_material_${kind}`, message: 'Private publication material is unavailable.' } }));
    };
    if (!enabled || req.url !== PUBLICATION_REPAIR_MATERIAL_PATH) { fail(404, 'disabled'); return true; }
    if (!reader) { fail(503, 'configuration'); return true; }
    if (req.method !== 'POST') { fail(405, 'invalid'); return true; }
    try {
      const proxy = proxies.has(req.socket.remoteAddress) && header(req, 'x-forwarded-proto') === 'https';
      if ((!req.socket.encrypted && !proxy) || !hosts.has(header(req, 'host'))
        || header(req, 'origin') !== undefined || header(req, 'cookie') !== undefined) throw Error();
      const supplied = Buffer.from(header(req, 'authorization') ?? '');
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) throw Error();
    } catch { fail(401, 'unauthorized'); return true; }
    if (!limiter.check('catsco-peer')) { fail(429, 'busy'); return true; }
    if (active >= 2) { fail(503, 'busy'); return true; }
    active++;
    const controller = new AbortController(), abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    const responseDone = new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); });
    const timer = setTimeout(() => { abort(); if (res.headersSent && !res.writableFinished) res.destroy(); }, 15000);
    const work = (async () => {
      const length = header(req, 'content-length');
      if (header(req, 'content-encoding') !== undefined
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(req, 'content-type') ?? '')
        || (length !== undefined && (!/^[1-9][0-9]{0,3}$/.test(length) || Number(length) > 4096))) throw new PublicationRepairMaterialError('invalid');
      let input;
      try { input = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readRaw(req, 4096, controller.signal)), { maxDepth: 5, maxNodes: 80 }); }
      catch { throw new PublicationRepairMaterialError(controller.signal.aborted ? 'unavailable' : 'invalid'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1
        || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'receipt')) throw new PublicationRepairMaterialError('invalid');
      return reader.read(input.receipt, { signal: controller.signal });
    })();
    // Neither timeout nor disconnect frees capacity while SQL or response
    // transmission is still unsettled. There is no background retry.
    void Promise.allSettled([work, responseDone]).then(() => {
      active--; clearTimeout(timer); req.off('aborted', abort); res.off('close', abort);
    });
    try {
      const raw = await withAbort(work, controller.signal);
      if (controller.signal.aborted || res.destroyed || res.writableEnded) throw new PublicationRepairMaterialError();
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': raw.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(raw);
    } catch (error) {
      const kind = error instanceof PublicationRepairMaterialError ? error.kind : 'unavailable';
      fail(({ invalid: 400, not_found: 404, conflict: 409, busy: 503 }[kind] ?? 503), kind);
    }
    return true;
  };
}
