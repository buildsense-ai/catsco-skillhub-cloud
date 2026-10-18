# Cloud receipt delivery and recovery

The internal dispatcher delivers historical candidate acceptance evidence to
the CatsCo receiver introduced in PR659. It survives response loss and process
restart using the existing PostgreSQL outbox. It does not authorize validation,
repair, publication or remote cancellation. Tasks remain `delegated_pending`.

## Invocation and isolation

`createPublicationReceiptDispatcher({enabled, issuer, audience, peerSecret, store})`
is default-off. An explicit trusted caller may use `runOnce()` or `start()` and
must await `stop()` at shutdown. There is no environment switch, HTTP route or
API/worker bootstrap registration in this stage. Deploying the module does not
start delivery. Account sessions cannot claim or complete these outbox events.

`start()` performs an immediate sweep and then polls five seconds after the
previous sweep completes; scheduled sweeps do not overlap. Manual calls have a
four-operation limit per dispatcher. Independent instances coordinate through
database leases. Shutdown stops scheduling, aborts active HTTPS requests and
waits for bounded in-flight settlement; it does not reset durable attempts.

## Authenticated wire contract

POST only to the configured canonical HTTPS issuer at
`/api/skillhub/publications/internal/cloud-receipts`, using the dedicated service
Bearer secret. Native HTTPS does not follow redirects or consult proxy
environment variables. Certificate verification remains required. The request
contains exactly these eleven fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `entryRequestId` | Original CatsCo publication entry |
| `candidateRevision` | `1` |
| `acceptanceEpoch` | Immutable first acceptance epoch, not latest renewal |
| `requestHash` | Exact original request SHA-256 |
| `sourceSnapshotHash` | Original canonical candidate SHA-256 |
| `requestBytes` | Original request byte count, 1 to 75 MiB |
| `delegationId` | Stable original upload grant ID |
| `idempotencyKey` | Stable original candidate key |
| `taskId` | Original Cloud task ID |
| `eventId` | Original outbox event ID |

No upload token, candidate bytes, local paths, account IDs, execution state or
caller-selected URL is sent. The client snapshots input before awaiting network
I/O. It allows 16 active transports, six seconds per request and 4 KiB of reply,
with strict JSON, content type, no-store, UTF-8 and no content encoding. Slots
remain occupied until transport closure, including abort and invalid responses.

Success requires an exact seven-field 200 JSON ACK: `schemaVersion:1`,
`recorded:true`, matching `entryRequestId`, `eventId` and `taskId`, boolean
`localIntentCancelled`, and `commitAllowed:false`. `localIntentCancelled` records
the receiver's transaction-time observation: false is not live authority and
true is not proof that a remote task was stopped. It never changes Cloud task
state. A strictly decoded 409 `publication.receipt_conflict` blocks the event;
all other transport/protocol failures consume a bounded retry. Raw upstream
messages, credentials and source bytes are never persisted in delivery status.

## Durable state transitions

Migration 017 adds outbox delivery state, attempts, due time, lease identity and
deadline, final ACK timestamp, cancellation observation and a bounded local
failure code. Task ID, event ID and creation time are immutable. Claiming uses
`FOR UPDATE SKIP LOCKED`, scoped by issuer and audience before the limit, without
loading candidate buffers or holding locks across network I/O.

| Result | Durable state |
| --- | --- |
| Due event claimed | `leased`, new UUID lease, 30-second deadline, increment attempt |
| Exact ACK | `delivered`, retain timestamp and local cancellation observation |
| Exact evidence conflict | `blocked`, `conflict` |
| Missing retained evidence | `blocked`, `evidence_missing`, no network request |
| Transient failure before attempt eight | `pending`, exponential delay |
| Transient failure at attempt eight | `exhausted` |
| Crash before completion | Reclaim after lease expiry with the same receipt and a new lease |
| Crash on attempt eight | Bounded maintenance marks `exhausted` |

Backoff is 5, 10, 20, 40, 80, 160, then 300 seconds. Claim/finish use bounded SQL
timeouts. Completion must match task/event/scope/lease and an unexpired deadline;
an old process cannot overwrite a newer attempt. A lost remote ACK or failed
local completion reuses the identical receipt, never creates another task or
event. Attempts are transport budget, not the three-round Skill repair budget.
Blocked and exhausted rows require a future authenticated operational recovery
protocol; this PR does not expose a reset API or silently replenish budgets.

Historical delivery is independent of current upload token validity, current
owner activity, publisher namespace, candidate retention or local cancellation.
Those facts still gate future execution; they must not erase accepted evidence.

## Migration and rollback

Apply migration 017 before running this version of intake. New associations
retain `request_bytes` even when ordinary maintenance clears the raw candidate.
For older rows the migration copies the byte count only when an intact candidate
has the same positive, bounded length. Already-cleared rows retain NULL; neither
delivery nor replay invents a value or restores files. The immutable association
trigger is disabled only during this transactional backfill and is restored
before commit. A failed migration rolls the entire change back.

Keep migration 016/017 evidence and guards when disabling delivery. A compatible
older intake omits the new nullable byte count, so rolling it back can produce
undeliverable receipts after candidate cleanup; do not roll back an activated
pipeline without a coordinated evidence-retention plan. This release still has
no active production caller. Never delete associations to force task/account
deletion or manually rewrite event IDs to evade a conflict.

## Verification and remaining work

Tests cover actual local HTTPS transport, strict ACK binding, bounded resource
use, dispatcher lifecycle, PostgreSQL concurrency/leases/backoff/exhaustion,
schema upgrade with legacy data, evidence preservation after cleanup and storage
failure after a successful response. Ordinary local tests without a database
skip PostgreSQL cases; CI supplies PostgreSQL and applies all migrations.

The separately pinned two-repository contract requires PostgreSQL and CatsCo
PR659's exact merge revision. It executes real Cloud intake/ledger/dispatcher,
real HTTPS and the actual CatsCo receiver with an explicit synchronized CatsCo
store double, including lost ACK, renewal, cancellation observation and process
reconstruction. This is not a real CatsCo database or live Bot end-to-end test.

Production bootstrap, retained-evidence operations, legacy publisher identity,
owner-private task status, delegated cancellation/commit ordering and retention,
runtime capture and trusted grant issuance/upload remain prerequisites. No paid
model calls, repair assistant, Chinese-guide generation or UI changes are added.
