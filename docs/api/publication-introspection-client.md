# Cloud publication authority client

The internal client in `packages/publication-delegation/introspection.js` checks
an upload grant against the authenticated CatsCo peer endpoint introduced in
[CatsCo PR656](https://github.com/buildsense-ai/cats-company/pull/656). It is one
part of the [delegation contract](publication-entrypoint-delegation.md), not an
upload API. No API handler or worker imports it yet; no database, account mapping,
task association, publication or original Skill changes occur.

## Configuration and service identity

The factory accepts trusted process configuration, never URL/identity fields
from an upload or model. `createPublicationIntrospectionClientFromEnv` reads the
following optional values; all existing APIs remain unchanged when absent or
invalid. Even setting them does not connect a caller to the client in this slice.

| Variable | Required policy |
| --- | --- |
| `SKILLHUB_PUBLICATION_INTROSPECTION_ENABLED` | Default off; trimmed `1` or case-insensitive `true`. |
| `SKILLHUB_PUBLICATION_CATSCO_ISSUER` | Explicit canonical HTTPS CatsCo origin, no path/query/credentials/fragment. |
| `SKILLHUB_PUBLICATION_CLOUD_AUDIENCE` | Explicit canonical HTTPS Cloud origin, different from issuer. |
| `SKILLHUB_PUBLICATION_CLOUD_PEER_SECRET` | Dedicated 256-bit secret encoded as 64 lowercase hex characters; matches the CatsCo peer secret. |

These are not inferred from user sessions, legacy service keys, Bot auth or
public-base-URL settings. Origin validation accepts lower-case DNS labels and
canonical IPv4 with an optional nonzero decimal port; IPv6 and URL-normalized
IPv4 shorthands are not accepted in this version. Explicit port 443 is permitted.
Configuration is captured when the client is constructed. Provision and rotate
the secret with CatsCo through the deployment secret manager; do not commit it
or put it in chat, model context, URLs, task payloads or ordinary logs. Redact both
`Authorization` and `X-SkillHub-Upload-Grant` in any instrumentation.

Native HTTPS sends only to the configured issuer's exact
`/api/skillhub/publications/internal/upload-grants/introspect` route, validates
certificates, does not follow redirects or use proxy environment variables, and
does not reuse a pooled authenticated socket. The optional constructor transport
dependency is for trusted tests only; it must never be supplied by a request.
There is no insecure-TLS environment option or HTTP localhost exception.

## Inputs and observations

`checkUploadGrant(input, { signal })` accepts exactly six input fields:

| Field | Meaning |
| --- | --- |
| `token` | Opaque `pubupload_` credential from the separate upload header. |
| `entryRequestId` | CatsCo `pubentry_` identity, not a source path. |
| `authorityEpoch` | Integer 1 through 8, matching the CatsCo issuance budget. |
| `rawBody` | Private Buffer of the exact intended Cloud candidate request bytes, 1 byte through 75 MiB. SharedArrayBuffer is rejected. |
| `sourceSnapshotHash` | Expected canonical pre-repair candidate digest. This client does not decode files or establish capture provenance. |
| `idempotencyKey` | Persisted `pubcandidate_` key for this entry revision; never invent a key on retry. |

Only revision 1 and action `candidate.upload` are supported. The client computes
SHA-256 and byte count synchronously from `rawBody`; bytes themselves never go
to CatsCo. The other fields are copied before network work. Per-call actor/Bot
UID, issuer, endpoint or request-hash overrides are rejected.

A successful call returns a frozen 15-field grant projection with canonical
CatsCo publisher/Bot UIDs as decimal strings, scope, source/request digests,
byte count, stable delegation/idempotency IDs, expiry and observation time.
It validates exact schema/fields/types, scope equality, canonical positive int64
UIDs without JavaScript number conversion, UTC timestamps, positive expiry and
at most 120 seconds remaining from observation. The observation must be recent
relative to this call, allowing at most five seconds clock skew; skew never
extends an expired token. Keep service clocks synchronized.

No result cache or automatic retry exists. A second call always checks again.
The returned observation is not a durable permission reservation, proof of a
valid Skill, Cloud publisher account, capture provenance or commit permit.

## Resource and failure bounds

There are at most 16 active requests per client instance, no queue. Each request
has a six-second wall-clock budget including DNS, connection, TLS, headers and
body; caller abort closes the same request. Slots are held until the request
closes. Response headers are capped at 8 KiB and body at 4 KiB, counted as bytes
while streaming. The response must be no-store, uncompressed UTF-8 JSON with
one JSON Content-Type; duplicate keys, excessive structure, unknown fields,
truncated data and invalid Content-Length fail closed.

Only an exact HTTP 200 `{ "schemaVersion": 1, "active": false }` is interpreted
as inactive authorization. Other statuses, including CatsCo 401/403, disabled
404, rate limiting 429 and upstream 503, are authority-service failures, not
Skill format rejects. No response body or arbitrary exception code/message/cause
is copied into errors. Public `PublicationAuthorityError` codes are:

| Suffix after `skillhub.publication_authority_` | Status | Meaning |
| --- | --- | --- |
| `disabled` | 503 | Internal client not enabled. |
| `configuration` | 503 | Dedicated peer configuration invalid. |
| `invalid` | 400 | Client input fails the narrow contract. |
| `inactive` | 403 | CatsCo explicitly returned the exact inactive envelope. |
| `busy` | 503 | Sixteen requests already active. |
| `unavailable` | 503 | Transport, deadline, certificate, protocol, binding or clock checks failed. |

None should trigger automatic format repair or legacy-auth fallback. A future
route must keep its existing candidate byte, account/storage and execution
quotas, add bounded per-account/entry retry backoff, and propagate abort. Reuse
one client per process rather than constructing a new limiter for every request.
CatsCo's server-side peer/entry rate limits remain in force.

## Required acceptance wiring before upload

The client deliberately has no persistence side effects. Its caller must still:

1. Safely capture an immutable private candidate, keep the exact bytes through
   retries, and verify current source/runtime authority before grant issuance.
2. Run Cloud's bounded validation worker over those same bytes. Independently
   recompute the canonical candidate digest and compare it to the grant's
   `sourceSnapshotHash` for revision 1, also rechecking exact request hash/size
   before durable acceptance. Caller-supplied digests are not validation proof.
3. Map verified issuer plus CatsCo UID to the active Cloud publisher/profile;
   never map by name or silently adopt a cached logged-in account.
4. Atomically persist the unique entry/revision/task binding and callback outbox.
   An observation can become stale immediately after it returns; do not claim a
   distributed transaction or publication permission from this check alone.
5. Add delegated-task guards to all ordinary session routes and workers, plus
   authenticated association, cancellation and exact one-task commit-permit
   ordering. A session-only request must not bypass those guards.

Do not enable production delegated publication until this wiring, the runtime
adapter and isolated end-to-end acceptance pass. This client does not broaden
Skill visibility, perform model calls/billing, or change existing publish APIs.

## Verification

`node --test tests/integration/publication-introspection.test.js` runs actual
localhost HTTPS with an ephemeral certificate generated by OpenSSL. It covers
credential separation, exact byte hashing, binding/time/schema errors, redaction,
redirect/TLS failure, body/header limits, stalled headers/body, cancellation and
16 concurrent live requests. OpenSSL must be installed; absence fails the test.

`npm run test:publication-peer-contract` requires `CATSCO_CONTRACT_ROOT` pointing
to a CatsCo checkout with PR656. Optional `CATSCO_CONTRACT_REVISION` asserts the
exact commit. Missing counterpart/build/test failure is not skipped. CI pins
`e1414f31f76fe8ac824adb7989e30dd8fb893b0b` and blocks deployment on this job.
It builds a temporary Go fixture hosting the real CatsCo handler, trusts only
the test certificate, and calls it from the actual Cloud client. It exercises
valid canonical identities, wrong epoch/token/bytes, key mismatch and service
credential/certificate rejection. The source digest is generated by the real
Cloud validator. The Go store is an explicit synthetic double: this test proves
HTTP wire compatibility, not PostgreSQL authority races, live XiaoBa capture,
Cloud task persistence or a complete publishing flow.
