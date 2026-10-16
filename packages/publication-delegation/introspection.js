import { createHash } from 'node:crypto';
import https from 'node:https';
import { parseStrictJson } from '../publish-validation/index.js';

const PATH = '/api/skillhub/publications/internal/upload-grants/introspect';
const MAX_BYTES = 75 * 1024 * 1024;
const RESPONSE_BYTES = 4096;
const TIMEOUT_MS = 6000;
const HASH = /^[a-f0-9]{64}$/;
const ENTRY = /^pubentry_[a-f0-9]{32}$/;
const KEY = /^pubcandidate_[a-f0-9]{32}$/;
const TOKEN = /^pubupload_[a-f0-9]{64}$/;
const INPUT_KEYS = ['token', 'entryRequestId', 'authorityEpoch', 'rawBody', 'sourceSnapshotHash', 'idempotencyKey'];
const GRANT_KEYS = ['delegationId', 'issuer', 'audience', 'action', 'actorCatsCoUid', 'botUid',
  'entryRequestId', 'candidateRevision', 'authorityEpoch', 'requestHash', 'sourceSnapshotHash',
  'requestBytes', 'idempotencyKey', 'expiresAt', 'observedAt'];
const isString = (value, pattern) => typeof value === 'string' && pattern.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

// Static errors only. Never attach upstream exceptions, response text, request
// options, raw credentials or source bytes, even as Error.cause.
export class PublicationAuthorityError extends Error {
  constructor(kind = 'unavailable') {
    const messages = {
      disabled: 'Publication authority checks are disabled.',
      configuration: 'Publication authority configuration is unavailable.',
      invalid: 'Publication authority input is invalid.',
      inactive: 'Publication upload authority is not active.',
      busy: 'Publication authority checks are busy.',
      unavailable: 'Publication authority could not be checked.'
    };
    if (!Object.hasOwn(messages, kind)) kind = 'unavailable';
    super(messages[kind]);
    this.name = 'PublicationAuthorityError';
    this.code = `skillhub.publication_authority_${kind}`;
    this.status = kind === 'invalid' ? 400 : kind === 'inactive' ? 403 : 503;
  }
}

function validOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match = value.match(/^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/);
  if (!match || match[1].length > 253 || match[1].split('.').some(label =>
    label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  if (match[2] && (String(Number(match[2])) !== match[2] || Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
  try { return new URL(value).hostname === match[1]; } catch { return false; }
}

function uid(value) {
  return isString(value, /^[1-9][0-9]{0,18}$/) && BigInt(value) <= 9223372036854775807n;
}

function timestamp(value) {
  if (!isString(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/)) return NaN;
  const ms = Date.parse(value);
  // Date.parse normalizes some impossible calendar dates; do not accept those.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : NaN;
}

function projectObservation(text, query, key, issuer, audience, startedAt) {
  let value;
  try { value = parseStrictJson(text, { maxDepth: 4, maxNodes: 128 }); }
  catch { throw new PublicationAuthorityError(); }
  if (exact(value, ['schemaVersion', 'active']) && value.schemaVersion === 1 && value.active === false) {
    throw new PublicationAuthorityError('inactive');
  }
  if (!exact(value, ['schemaVersion', 'active', 'grant']) || value.schemaVersion !== 1 || value.active !== true ||
      !exact(value.grant, GRANT_KEYS)) throw new PublicationAuthorityError();
  const g = value.grant;
  if (!isString(g.delegationId, /^pubgrant_[a-f0-9]{32}$/) || !uid(g.actorCatsCoUid) || !uid(g.botUid) ||
      g.actorCatsCoUid === g.botUid || g.issuer !== issuer || g.audience !== audience || g.idempotencyKey !== key ||
      Object.entries(query).some(([k, v]) => k !== 'schemaVersion' && g[k] !== v)) throw new PublicationAuthorityError();
  const observed = timestamp(g.observedAt), expires = timestamp(g.expiresAt), now = Date.now();
  // No cached observation, positive expiry and at most five seconds clock skew.
  // Skew tolerance never extends an expired grant's life.
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed < startedAt - 5000 || observed > now + 5000 ||
      expires <= now || expires <= observed || expires - observed > 120000) throw new PublicationAuthorityError();
  return Object.freeze(Object.fromEntries(GRANT_KEYS.map(k => [k, g[k]])));
}

function singleHeader(res, name) {
  const values = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (res.rawHeaders[i].toLowerCase() === name) values.push(res.rawHeaders[i + 1]);
  }
  if (values.length > 1) throw new PublicationAuthorityError();
  return values[0];
}

// Native HTTPS never follows redirects, ignores proxy environment variables,
// checks server certificates and caps headers before exposing a response body.
// Keep the slot until the underlying request closes, including after abort.
function requestObservation(url, secret, token, body, signal, requestImpl) {
  return new Promise((resolve, reject) => {
    let req, response, outcome, failure, timer;
    const fail = () => {
      failure = new PublicationAuthorityError();
      response?.destroy();
      req?.destroy();
    };
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      if (failure || outcome === undefined) reject(failure ?? new PublicationAuthorityError());
      else resolve(outcome);
    };
    if (signal?.aborted) { reject(new PublicationAuthorityError()); return; }
    try {
      req = requestImpl(url, {
        method: 'POST', agent: false, rejectUnauthorized: true, maxHeaderSize: 8192,
        headers: {
          Authorization: `Bearer ${secret}`, 'X-SkillHub-Upload-Grant': token,
          Accept: 'application/json', 'Accept-Encoding': 'identity',
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store'
        }
      }, res => {
        response = res;
        // Attach error listeners before validation/destroy, including 3xx/5xx.
        res.on('error', fail);
        res.on('aborted', fail);
        const chunks = [];
        let size = 0, declared;
        try {
          if (res.statusCode !== 200) throw new PublicationAuthorityError();
          const type = singleHeader(res, 'content-type');
          if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type ?? '') ||
              singleHeader(res, 'content-encoding') !== undefined ||
              !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(singleHeader(res, 'cache-control') ?? '')) throw new PublicationAuthorityError();
          const length = singleHeader(res, 'content-length');
          if (length !== undefined) {
            if (!/^[1-9][0-9]{0,3}$/.test(length) || Number(length) > RESPONSE_BYTES) throw new PublicationAuthorityError();
            declared = Number(length);
          }
        } catch { fail(); return; }
        res.on('data', chunk => {
          size += chunk.length;
          if (size > RESPONSE_BYTES) { fail(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (failure) return;
          try {
            if (!res.complete || size === 0 || (declared !== undefined && declared !== size)) throw new PublicationAuthorityError();
            outcome = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
          } catch { fail(); return; }
          req.destroy();
        });
      });
      req.on('error', fail);
      req.once('close', finish);
      timer = setTimeout(fail, TIMEOUT_MS);
      signal?.addEventListener('abort', fail, { once: true });
      if (signal?.aborted) fail();
      else req.end(body);
    } catch {
      if (req) fail();
      else { clearTimeout(timer); signal?.removeEventListener('abort', fail); reject(new PublicationAuthorityError()); }
    }
  });
}

// This is an internal client, not an upload route or a grant issuer. Config and
// optional transport injection are trusted process dependencies, never request
// fields. The latter exists for tests; normal construction uses native HTTPS.
export function createPublicationIntrospectionClient(config = {}, { requestImpl = https.request } = {}) {
  const enabled = config.enabled === true;
  const { issuer, audience, peerSecret } = config;
  const ready = validOrigin(issuer) && validOrigin(audience) && new URL(issuer).origin !== new URL(audience).origin && isString(peerSecret, HASH);
  let active = 0;
  return Object.freeze({
    async checkUploadGrant(input, { signal } = {}) {
      if (!enabled) throw new PublicationAuthorityError('disabled');
      if (!ready) throw new PublicationAuthorityError('configuration');
      if (!exact(input, INPUT_KEYS) || !isString(input.token, TOKEN) || !isString(input.entryRequestId, ENTRY) ||
          !Number.isInteger(input.authorityEpoch) || input.authorityEpoch < 1 || input.authorityEpoch > 8 ||
          !isString(input.sourceSnapshotHash, HASH) || !isString(input.idempotencyKey, KEY) ||
          !Buffer.isBuffer(input.rawBody) || input.rawBody.length < 1 || input.rawBody.length > MAX_BYTES ||
          input.rawBody.buffer instanceof SharedArrayBuffer) throw new PublicationAuthorityError('invalid');
      if (active >= 16) throw new PublicationAuthorityError('busy');
      active++;
      try {
        if (signal?.aborted) throw new PublicationAuthorityError();
        // Compute transport facts locally, synchronously before any await. Only
        // the digest/size leave Cloud; no files or candidate bytes go to CatsCo.
        const query = {
          schemaVersion: 1, entryRequestId: input.entryRequestId, action: 'candidate.upload',
          candidateRevision: 1, authorityEpoch: input.authorityEpoch,
          requestHash: createHash('sha256').update(input.rawBody).digest('hex'),
          sourceSnapshotHash: input.sourceSnapshotHash, requestBytes: input.rawBody.length
        };
        const token = input.token, key = input.idempotencyKey, startedAt = Date.now();
        const text = await requestObservation(issuer + PATH, peerSecret, token, JSON.stringify(query), signal, requestImpl);
        if (signal?.aborted) throw new PublicationAuthorityError();
        return projectObservation(text, query, key, issuer, audience, startedAt);
      } finally { active--; }
    }
  });
}

export function createPublicationIntrospectionClientFromEnv(env = process.env) {
  return createPublicationIntrospectionClient({
    enabled: /^(1|true)$/i.test((env.SKILLHUB_PUBLICATION_INTROSPECTION_ENABLED ?? '').trim()),
    issuer: (env.SKILLHUB_PUBLICATION_CATSCO_ISSUER ?? '').trim(),
    audience: (env.SKILLHUB_PUBLICATION_CLOUD_AUDIENCE ?? '').trim(),
    peerSecret: env.SKILLHUB_PUBLICATION_CLOUD_PEER_SECRET
  });
}
