# Held delegated task cancellation

Cloud can now durably cancel an exact held task and observe its local state.
This is a default-off **internal storage primitive**, not an authenticated API
or a completed CatsCo cancellation flow. It has no production caller, environment
switch, HTTP route or worker registration. It does not issue commit permits.

## Internal contract and authority boundary

`createDelegatedPublicationControlStore({enabled, store, issuer, audience})`
returns `read(receipt)` and `cancel(receipt)`. Explicit `enabled: true` and
distinct configured HTTPS peers are required. Input must be the exact eleven
fields of the [historical acceptance receipt](publication-receipt-delivery.md),
including the **first acceptance epoch**, not a renewed upload token epoch.
The database matches every field plus configured issuer/audience. Missing and
mismatched references share one safe `not_found` error; no arbitrary owner ID,
namespace, token, callback URL or raw error is returned.

The reference is an identifier, not a credential. Before exposing this primitive,
a future service adapter must authenticate the independently configured CatsCo
peer. CatsCo must first verify the original active human and current Bot Owner,
serialize cancellation against commit authorization and durably record the
cancellation intent. The receipt ACK's `localIntentCancelled` boolean, an upload
grant or an ordinary account session must **never** invoke cancellation directly.
Historical private reads must separately authenticate the original active human;
ownership transfer does not grant access to the new Owner.

The store intentionally does not join current Cloud user/profile activity or
namespace: already-authorized cancellation must be recoverable after disablement
or a publisher rename, and historical identity is immutable. This is not a
shortcut around the future upstream action authorization.

The observation contains only `schemaVersion:1`, `entryRequestId`, `taskId`,
`candidateRevision:1`, `executionState`, `candidateAvailable`, `cancelledAt`
(nullable) and `observedAt`. It contains no source bytes, validation report,
credentials, owner identity or internal SQL. This is an internal snapshot, not
the CatsCo PR660 browser projection, whose `executionState` remains `unknown`.
No browser capability changes in this release.

## State and recovery

| Operation | Result |
| --- | --- |
| Read `delegated_pending` | Held task, not publication success; expired candidate has `candidateAvailable:false` |
| Cancel `delegated_pending` | Atomically record `cancelled` and immutable cancellation time; clear private candidate buffer |
| Cancel/read `cancelled` again | Same task and cancellation time, without another mutation |
| Unknown execution state or any commit record | Conflict, no claim of cancellation |
| SQL/connection failure | Safe storage error; reconcile the same reference, not a new task |

Cancellation locks the task row for update. Reads and intake replays use a shared
task lock, so their observation is ordered before or after cancellation. Queries
never materialize candidate buffers. There is no network, model or workspace
work under these locks. Each store instance caps operations at 16 until SQL
settles; SQL has five-second lock and ten-second statement timeouts. These are
per-statement limits, not an end-to-end HTTP deadline. A future adapter also
needs finite transport budgets and per-account throttles.

An intake retry still checks the live upload grant. If that check permits
historical reconciliation, it returns the actual stored cancelled state and
original task/event/epoch, never restores source bytes or creates a replacement.
The acceptance outbox continues delivery for cancelled tasks, including after
lost ACKs, because acceptance evidence remains true. Delivery neither cancels
nor revives the task, regardless of the ACK's historical cancellation boolean.

The new cancellation erases only Cloud's private candidate buffer for that task.
It does not delete local Skills, installed packages, published versions, reports,
associations or receipt evidence. Metadata continues to count toward existing
quotas; this is not the final retention/GC policy.

## Migration and rollback

Apply migration 018 before deploying this code. It adds the cancellation time,
allows only held or cancelled delegated states, and enforces terminal cancellation
and no candidate restoration. Ordinary task states are unchanged. A commit-table
guard rejects delegated inserts/updates until a subsequent permit-aware migration
explicitly supports them; ordinary account commits retain their existing checks.
Existing evidence and ordinary commit records are not rewritten.

Disable callers without removing these guards or retained evidence. Older intake
code hard-codes `delegated_pending` in replay replies and older delivery code
ignores cancelled rows, so do not roll back those modules once cancellation is
used. Roll forward with compatible code; do not relabel cancelled tasks or delete
associations to force rollback. No production activation is included here.

## Verification and next steps

Tests cover strict inputs, default-off operation, bounded concurrency, safe
errors, real PostgreSQL idempotence/reconstruction, field/scope mismatch,
read/cancel ordering, expiry and account changes, concurrent intake replay,
receipt delivery on both sides of cancellation, rollback/lost completion,
schema guards, ordinary task isolation and migration with pre-existing data.
Local runs without a DSN skip PostgreSQL; CI must execute these cases without
skips. The existing two-repository HTTPS contract remains an independent
acceptance/receipt test, not an end-to-end cancellation test.

Next: durable CatsCo cancel intent and service authentication/delivery, Cloud
execution-status transport, then immutable commit intent/permit and crash/race
ordering on both sides. CatsCo must not report a remote cancellation solely from
its local record. Full runtime capture/upload, lifecycle handling, isolated
acceptance and explicit production approval remain prerequisites. Repair,
Chinese-guide generation, billing and UI are unchanged.
