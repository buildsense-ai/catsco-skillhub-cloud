import https from 'node:https';
import { parseStrictJson } from '../publish-validation/index.js';
import { validPublicationCommitTarget } from '../publication-delegation/commit-permit-client.js';
import { validReceiptPeerConfig } from '../publication-delegation/receipt-client.js';

export const DESCRIPTION_RELEASE_PERMIT_PATH = '/api/skillhub/publications/internal/description-release-permits/authorize';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const matches = (value, pattern) => typeof value === 'string' && value.match(pattern)?.[0] === value;
const digest = /^[a-f0-9]{64}$/;
const same = (a, b) => exact(a, Object.keys(b)) && Object.keys(b).every(key => a[key] === b[key]);

function validAuthorizedAt(value) {
  if (!matches(value, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/)) return false;
  const whole = value.slice(0, 19) + '.000Z', at = new Date(whole);
  return Number.isFinite(at.getTime()) && at.toISOString() === whole && at.getUTCFullYear() > 1;
}

export function validDescriptionReleasePermitRequest(value) {
  return exact(value, ['schemaVersion', 'entryId', 'applicationId', 'target']) && value.schemaVersion === 1
    && matches(value.entryId, /^pubentry_[a-f0-9]{32}$/)
    && matches(value.applicationId, /^pubdesc_[a-f0-9]{64}$/)
    && validPublicationCommitTarget(value.target);
}

export function validDescriptionReleasePermit(value, request) {
  return validDescriptionReleasePermitRequest(request)
    && exact(value, ['schemaVersion', 'entryId', 'applicationId', 'target', 'intentHash', 'permitId', 'authorizedAt'])
    && value.schemaVersion === 1 && value.entryId === request.entryId && value.applicationId === request.applicationId
    && same(value.target, request.target) && matches(value.intentHash, digest)
    && matches(value.permitId, /^pubdescpermit_[a-f0-9]{32}$/) && validAuthorizedAt(value.authorizedAt);
}

export class PublicationDescriptionReleasePermitError extends Error {
  constructor(kind = 'unavailable') {
    const messages = {
      disabled: 'Description release permit consumption is disabled.',
      configuration: 'Description release permit configuration is unavailable.',
      invalid: 'Description release permit request is invalid.',
      busy: 'Description release permit client is busy.',
      denied: 'Description release authority was denied.',
      cancelled: 'Description release intent was cancelled.',
      conflict: 'Description release intent conflicts with the retained plan.',
      unavailable: 'Description release permit is unavailable.'
    };
    if (!Object.hasOwn(messages, kind)) kind = 'unavailable';
    super(messages[kind]);
    this.name = 'PublicationDescriptionReleasePermitError';
    this.code = `skillhub.publication_description_release_permit_${kind}`;
  }
}

// Native HTTPS only: no proxy env, redirects, caller URLs or browser credentials.
// A transport timeout remains ambiguous, so callers must retry the same target.
function send(url, secret, body, signal, requestImpl) {
  return new Promise((resolve, reject) => {
    let req, res, timer, result, failed = false;
    const fail = () => { failed = true; res?.destroy(); req?.destroy(); };
    const finish = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', fail);
      if (failed || !result) reject(new PublicationDescriptionReleasePermitError()); else resolve(result);
    };
    if (signal?.aborted) { reject(new PublicationDescriptionReleasePermitError()); return; }
    try {
      req = requestImpl(url, { method: 'POST', agent: false, rejectUnauthorized: true, maxHeaderSize: 8192,
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', 'Accept-Encoding': 'identity',
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' } }, response => {
        res = response; res.on('error', fail); res.on('aborted', fail);
        const header = name => {
          const values = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) if (res.rawHeaders[i].toLowerCase() === name) values.push(res.rawHeaders[i + 1]);
          if (values.length > 1) throw new Error();
          return values[0];
        };
        let declared, size = 0; const chunks = [];
        try {
          if (![200, 403, 409].includes(res.statusCode)
            || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type') ?? '')
            || header('content-encoding') !== undefined
            || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(header('cache-control') ?? '')) throw new Error();
          const length = header('content-length');
          if (length !== undefined) {
            if (!matches(length, /^[1-9][0-9]{0,3}$/) || Number(length) > 4096) throw new Error();
            declared = Number(length);
          }
        } catch { fail(); return; }
        res.on('data', chunk => { size += chunk.length; if (size > 4096) { fail(); return; } chunks.push(chunk); });
        res.on('end', () => {
          if (failed) return;
          try {
            if (!res.complete || size === 0 || (declared !== undefined && size !== declared)) throw new Error();
            result = { status: res.statusCode, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)) };
          } catch { fail(); return; }
          req.destroy();
        });
      });
      req.on('error', fail); req.once('close', finish);
      timer = setTimeout(fail, 6000); signal?.addEventListener('abort', fail, { once: true });
      if (signal?.aborted) fail(); else req.end(body);
    } catch {
      if (req) fail(); else { clearTimeout(timer); signal?.removeEventListener('abort', fail); reject(new PublicationDescriptionReleasePermitError()); }
    }
  });
}

export function createPublicationDescriptionReleasePermitClient(config = {}, { requestImpl = https.request } = {}) {
  const enabled = config.enabled === true, ready = validReceiptPeerConfig(config);
  let active = 0;
  return Object.freeze({ async authorize(input, { signal } = {}) {
    if (!enabled) throw new PublicationDescriptionReleasePermitError('disabled');
    if (!ready) throw new PublicationDescriptionReleasePermitError('configuration');
    if (!validDescriptionReleasePermitRequest(input)) throw new PublicationDescriptionReleasePermitError('invalid');
    if (active >= 16) throw new PublicationDescriptionReleasePermitError('busy');
    const request = Object.freeze({ schemaVersion: 1, entryId: input.entryId, applicationId: input.applicationId,
      target: Object.freeze({ ...input.target }) });
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 4096) throw new PublicationDescriptionReleasePermitError('invalid');
    active++;
    try {
      const response = await send(config.issuer + DESCRIPTION_RELEASE_PERMIT_PATH, config.peerSecret, body, signal, requestImpl);
      if (signal?.aborted) throw new PublicationDescriptionReleasePermitError();
      let value;
      try { value = parseStrictJson(response.text, { maxDepth: 6, maxNodes: 128 }); }
      catch { throw new PublicationDescriptionReleasePermitError(); }
      if (response.status !== 200) {
        const codes = response.status === 403 ? { 'publication.commit_denied': 'denied' }
          : { 'publication.commit_cancelled': 'cancelled', 'publication.commit_conflict': 'conflict' };
        if (exact(value, ['error']) && exact(value.error, ['code', 'message'])
          && Object.hasOwn(codes, value.error.code) && typeof value.error.message === 'string') {
          throw new PublicationDescriptionReleasePermitError(codes[value.error.code]);
        }
        throw new PublicationDescriptionReleasePermitError();
      }
      if (!validDescriptionReleasePermit(value, request)) throw new PublicationDescriptionReleasePermitError();
      Object.freeze(value.target);
      return Object.freeze(value);
    } finally { active--; }
  } });
}
