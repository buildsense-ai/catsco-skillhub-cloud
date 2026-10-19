# Runtime candidate upload

`POST /api/skills/publication-delegations/candidates` accepts the exact private
candidate bytes retained by XiaoBa. It is default-off and does not publish a
Skill, approve a version, repair content, or invoke a model.

## Authentication and wire format

Enable `SKILLHUB_PUBLICATION_UPLOAD_ENABLED` only after the remaining isolated
capture/grant/routing acceptance. Configure the matching `_ISSUER`, `_AUDIENCE`,
`_PEER_SECRET` and optional `_TRUSTED_PROXY_ADDRESSES`. Publication tasks must
also be enabled. Invalid configuration fails closed without disabling old APIs.
The peer secret authenticates Cloud's outbound CatsCo introspection; it must
never be provided to a Bot, browser or model, or reused from a session/agent key.

The URL must match exactly, with no query string. The fixed HTTPS audience is
checked against Host; plaintext is rejected unless the immediate peer is an
explicitly configured sanitizing TLS reverse proxy. There is no CORS, Cookie,
Origin, session, Bot API-key or service-bearer fallback. Only POST is allowed.

Required single-valued headers:

- `Authorization: Bearer pubupload_<64 lowercase hex>`
- `X-Publication-Entry: pubentry_<32 lowercase hex>`
- `X-Publication-Epoch: 1` through `8`
- `X-Publication-Source-Hash: <64 lowercase hex>`
- `Idempotency-Key: pubcandidate_<32 lowercase hex>`
- `Content-Type: application/json` (optional UTF-8 charset)
- `Content-Length: <exact positive byte count>`

The body is the unchanged source-only publication JSON request. No compression,
chunked transfer, caller-selected authority URL or human identity fields are
accepted. The source hash is the Cloud candidate digest, not the workspace
generation. Request identity is computed from the received bytes by the pinned
introspection client; no caller-supplied request hash is trusted.

Before parsing/validation or database maintenance, online CatsCo introspection
must validate the byte-bound grant. Intake repeats the check after validation
and checks expiry inside the transaction. Account rate limiting uses only the
verified publisher UID. No observation or positive authority is cached.

## Responses and retry

201 means a private candidate task was created; 200 means an exact replay found
the original task. Both return `schemaVersion:1`, `accepted:true`, `created`,
and a minimal `association` with task/entry/revision, candidate/request hashes,
original acceptance epoch, event ID, state and candidate availability. These
are receipt observations, not commit permission or a claim of publication.
Replay may observe cancelled or expired bytes; it never restores them.

Readable but format-rejected candidates are retained with their bounded private
validation report, so acceptance does not mean validation passed. Unsafe input
which cannot produce a complete candidate yields 422 without a task. Other
errors use static `skillhub.publication_upload_*` codes: inactive/publisher
identity 403, candidate conflict 409, byte limit 413, rate/storage budget 429,
and timeout/upstream/storage availability 503. Responses never include a token,
source body, SQL error, or arbitrary upstream error text. Detailed repair-report
delivery remains the owner-private task/report integration, not this endpoint.

After lost replies or 503, retry the same entry, revision, exact bytes and key
with a currently valid scoped grant. A timeout is not proof of rollback. The
same immutable association and outbox event are recovered without a second task.
The account/session task APIs still cannot read or publish delegated tasks.

## Resource limits and verification

Request bytes are capped at the smaller configured validation limit or 32 MiB;
concurrency at the smaller configured validation limit or four operations.
Reads have at most ten seconds and the overall operation at most sixty seconds.
Timed-out/disconnected work keeps its slot until actual settlement. There are
global 60/minute, immediate-peer IP 30/minute and verified-account 10/minute
budgets with bounded bucket storage. Forwarded IP, token and entry cannot shard
those budgets. A shared reverse proxy shares the pre-auth IP budget; capacity
tuning and proxy body limits are rollout checks, not reasons to trust XFF.

HTTP tests cover strict transport/header/auth boundaries, replay projections,
slow bodies, held slots, private errors and legacy API coexistence. The required
three-repository contract pins reviewed XiaoBa PR540 and CatsCo PR672, verifies
three actual captures against Cloud validation, uploads real captured bytes
over HTTPS, loses the first committed upload response, and replays into the
existing dual-PostgreSQL/human-confirmation/dispatcher/Git/signed-package flow.
The capture fixture and CatsCo grant issuance are still test adapters: this is
not proof of live Bot routing, trusted capture dispatch or complete UI E2E.
No production feature flag is enabled by this change.
