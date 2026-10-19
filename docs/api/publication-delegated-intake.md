# Delegated publication intake foundation

Cloud can atomically retain an immutable candidate, its CatsCo association and
one reference-only callback outbox record. This foundation is disabled
by default; its separately gated [runtime HTTP adapter](publication-candidate-upload.md)
authenticates scoped upload grants before admission. `delegated_pending`
means held for a future protocol, not validated for publication or published.

## Admission and identity

`createDelegatedPublicationIntake` requires explicit internal enablement,
publication task settings, configured canonical HTTPS issuer/audience and the
pinned introspection client. The HTTP adapter has an independent default-off switch.
Input is the six-field introspection request, including the opaque grant and
exact candidate bytes; Cloud owner IDs, profile IDs and arbitrary fields are
rejected. A configured concurrency cap covers the entire operation, including
database settlement after client cancellation. The HTTP adapter additionally
provides pre-validation grant checks, read deadlines and verified-account rate limits.

Before the first await, admission snapshots the input. The bounded validation
worker parses those bytes and computes the canonical candidate digest. Only a
complete report with that digest can be retained; the initial revision must
match the captured source digest. Readable format-rejected Skills are retained
with their bounded rejection report. Unsafe or undecodable input returns its
validation result without a task. Introspection follows validation and must
match bytes, digest, entry, revision, key, epoch, issuer, audience and identities.
The grant is checked again for expiry inside the SQL transaction. No validation,
network, model or filesystem work occurs under database locks.

The database finds a non-NULL issuer/UID mapping, locks and rechecks the active
Cloud user and publisher profile, then captures the publisher ID and namespace.
Legacy UID-only profiles are rejected; there is no backfill or name-based adoption.
This is intake authorization observed at grant use, not durable permission to
publish. CatsCo revocation after observation must still win before the future
commit-permit boundary. This PR does not implement that boundary.

## Atomic association and replay

Migration 016 adds `authority_kind` to publication tasks, an immutable
`publication_delegations` association and `publication_delegation_outbox`.
The association is unique by `(issuer, entry_request_id, candidate_revision)`
and constrained to a CatsCo task. All three inserts share one transaction.
The outbox stores only a stable event ID and task reference, never tokens,
candidate files or raw upstream responses. The internal, default-off receipt
dispatcher is described in [Receipt delivery](publication-receipt-delivery.md);
it has no production bootstrap or environment enablement.

Retries revalidate the bytes and live grant. Exact retries return the same task
and event; changed publisher, Bot, delegation ID, namespace, key or bytes conflict.
CatsCo renewal preserves the delegation ID and key, rotates the token and
increments its epoch (at most eight issuances). A freshly introspected renewal
at an epoch greater than or equal to the original acceptance epoch can recover
the original receipt. Older epochs are rejected; a new delegation ID cannot
reuse an accepted association even with a higher epoch. No token validity is
inferred from the numeric comparison: online introspection remains mandatory.
The stored acceptance epoch and receipt are immutable historical evidence,
not the latest token epoch or a commit permit. Renewal never updates them,
changes held state, restores expired bytes or creates another event.
An outbox insertion failure rolls back both task and association. Lost responses
are reconciled by retrying the same entry and bytes, not allocating a new key.

Admission uses the existing global intake lock and shared per-owner/global task
and byte budgets. Ordinary account tasks and delegated candidates consume the
same quotas; an account request cannot reuse a delegated task's key as a replay.

## Execution isolation and retention

Ordinary session routes cannot list, read, cancel or publish a delegated task.
Both validation and publication workers select only account tasks. Database
constraints hold delegated tasks in `delegated_pending` or terminal `cancelled`,
without leases, commit records or commit bytes; an immutable authority guard prevents relabelling a task to bypass
those filters. A future delegated read/cancel API must use CatsCo authority and
must not remove these ordinary-session restrictions.

The default-off [internal control store](publication-delegated-control.md) can
cancel an exact held task and read its local state. Migration 018 makes that
cancellation terminal. Intake replay reports the actual stored state, never a
hard-coded pending state, and cannot restore cancelled source bytes. This is not
yet an authenticated owner-facing cancellation or live status API.

Maintenance clears expired candidate bytes in bounded batches without changing
the held state. Associations and outbox records survive the ordinary purge
deadline, and retry never restores expired source bytes. Their retained task
count continues to consume quota, bounding metadata growth. This is a temporary
held-state policy, not the completed production lifecycle. The foreign key
restricts task/account deletion while associations exist; production activation
requires an explicit cancellation/tombstone/cleanup policy first. Do not bypass
this protection by deleting associations during ordinary request handling.

## Deployment and remaining gates

Apply migration 016 before deploying the new binary. No configuration or
production enablement changes are included. If held records exist, do not roll
back to older task maintenance: it does not recognize them and can attempt
forbidden expiry transitions. Keep the compatible worker and schema; disabling
admission alone is not permission to drop replay evidence or database guards.

Migration 017 additionally retains the original request byte count separately
from expiring candidate buffers. Apply it before deploying the updated intake.
Existing intact candidates can supply this evidence; already-cleared legacy
candidates cannot and their receipt delivery is blocked, not guessed.

Still required: evidence-backed legacy identity binding, production callback
bootstrap and operational reconciliation, owner-private read/cancel protocol,
commit-permit ordering, final retention/deletion rules, runtime capture/grant
issuance/upload, isolated cross-repository acceptance, then production review.
There is no repair, Chinese-guide generation, billing or UI change here.

Tests cover immutable snapshots, strict input and peer bindings, real PostgreSQL
replays/concurrency/rollback, identity and expiry checks, quotas, held retention,
session HTTP denial, worker exclusion and ordinary task coexistence. Peer
observations in these new database tests are injected. The separate pinned
HTTPS contract also exercises real Cloud intake/PostgreSQL and the CatsCo
handler with a rotation-aware CatsCo store double, including old-token denial
and renewed-token recovery. That contract requires a PostgreSQL DSN and applies
Cloud migrations in CI; missing dependencies fail rather than skip. Neither substitutes
for a deployed three-component publication flow.
