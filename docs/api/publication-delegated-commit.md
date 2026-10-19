# Delegated publication commit coordination

The internal Cloud coordinator joins an accepted CatsCo delegation to the
existing recoverable publisher. An independently default-off service adapter
exposes plan/read/authorize to CatsCo, not browsers or model tools. It does not
accept browser-supplied proof or enable a production flow. A separate default-off
worker lane schedules only commits with durable permits.
Both explicit internal enablement and publication-task/publishing configuration
are required. The default account worker and session APIs cannot claim, read,
cancel or publish these tasks.

## Frozen plan and authority

`createDelegatedPublicationCommitCoordinator(...).prepare(receipt,
{confirmVersionPublish})` matches the complete original receipt and fixed
issuer/audience, checks the active Cloud user and issuer-bound publisher profile,
and preflights the candidate outside database locks. Only then does it reserve
one public version and persist the exact manifest, release identity and target.
Concurrent/repeated preparation returns the same plan; a changed confirmation
choice conflicts. An expired unplanned candidate cannot reserve a version.
A frozen plan can be read after expiry but does not itself authorize publication.

The target contains candidate/manifest hashes, publisher user/profile/namespace,
Skill/version/upload IDs, release time and the version-confirmation choice.
The manifest digest uses Cloud canonical JSON. The boolean is a plan parameter,
not evidence of human approval. The future CatsCo adapter must authenticate
the human request, verify the exact returned facts and persist the required
confirmation before asking Cloud to execute it. No model or upload token may
write that trusted intent.

## Permit and cancellation ordering

`authorize(receipt)` prepares the frozen material and calls the strict CatsCo
permit client with no SQL/workspace lock held. An exact successful reply is
stored together with the commit record and `committing` transition in one
transaction, sharing the task-row lock with Cloud cancellation.

- Cloud cancellation first: the late reply cannot restore candidate bytes or
  start execution. A retained plan/reservation remains historical evidence.
- Cloud commit first: cancellation returns conflict, never false success.
- CatsCo cancellation before its first permit: authorization is denied.
- CatsCo permit issued but response lost: retry the identical plan to obtain
  the original permit and timestamp, provided Cloud has not cancelled.
- Cloud commit response lost: replay the retained proof/state locally; no new
  permit, version or retry-budget reset.

The two service transactions are distinct boundaries, not a distributed SQL
transaction. Once CatsCo has issued a permit, later CatsCo cancellation does
not undo it; Cloud cancellation can still win until Cloud commits its boundary.
The CatsCo cancellation sender currently treats commit conflict as unresolved,
not confirmed cancellation. A later status adapter must expose the true outcome.

## Worker recovery and retention

`processDelegatedPublicationCommit(config,{enabled:true,store})` is an explicit
internal entry into the existing Git, scan, signing, artifact and catalogue
workflow. It claims only CatsCo tasks with commit evidence. It rechecks active
Cloud publisher identity before writes/checkpoints and in final catalogue
completion. A historical CatsCo permit does not bypass those Cloud checks.

Immutable release IDs/material make retries after Git, packaging or checkpoint
interruptions reuse one version. Task leases fence stale completion; attempts
remain bounded at three and replay does not restart exhausted work. Receipt
delivery can still recover after commit/publication without recreating source.

Migration 019 is additive, does not backfill plans or permits, and preserves
held/cancelled/account rows. Plans, permits and checkpoints count against the
existing storage quota under its common lock. No automated GC removes delegated
evidence. Update guards and restrictive foreign keys protect normal writes;
privileged database deletion is not an application lifecycle API. Do not
roll back to pre-019 workers after using this path; disable its caller instead
and retain the database and publication artifacts for recovery.

## Verification and remaining integration

Required CI runs real PostgreSQL regression, cancellation races, quota rollback,
schema upgrade, immutable scope, inactive publishers, ordinary-path isolation,
stale leases, bounded attempts and Git/artifact/checkpoint recovery. The real
dual-store test uses the reviewed CatsCo PR670 merge over verified TLS and
actual Cloud intake/plan/worker code. It drops a permit reply, reopens the CatsCo
adapter, publishes one signed package after an injected interruption, and checks
both cancellation orderings. A separate scenario exercises real signed human
JWT plan/confirm/status HTTP requests, rejects a wrong confirmation key and
another actor, and verifies published status after restart. Older race fixtures
seed human intent; Runtime probe/capture remains synthetic. This is not a live UI E2E.

Remaining work includes CatsCo durable dispatch, Runtime capture/upload, and private
user-visible progress. Only after isolated cross-repository acceptance should
the production switches be considered. Bounded repair and Chinese guide/model
billing are later milestones, unchanged by this commit layer.

## Authenticated service adapter

`POST /api/skills/publication-delegations/commit` accepts exact JSON
`{schemaVersion:1,action,receipt}`; action `plan` additionally requires a boolean
`confirmVersionPublish`. Only `plan`, `read` and `authorize` are accepted. A
caller cannot supply a target, permit, publisher UID or source bytes. Responses
echo the exact historical receipt: plan returns its frozen target, authorize
returns current state/permit ID, and read returns state plus nullable target,
permit ID, final result and an allowlisted error code. Only a published read
contains Skill/version/package/checksum/time. Read does not alter any ledger.

`SKILLHUB_PUBLICATION_COMMIT_SERVICE_ENABLED` defaults false. Static issuer,
audience, peer secret and exact trusted-proxy addresses have dedicated settings;
TLS, audience Host and a dedicated service Bearer are mandatory. Cookies,
Origin, duplicate auth/JSON, encoded/oversized requests and unknown routes fail
closed before account auth/CORS. Generic agent/session/mutation secrets are
rejected as this service credential. The handler allows four concurrent calls,
60 authenticated calls/minute and a 20-second response budget. Work slots remain
occupied until underlying work settles after disconnect/timeout. Cancellation
or timeout never implies that a transaction rolled back.

The peer must authorize the original human before planning/status and persist
exact trusted human intent before authorize. The service secret cannot mint
that intent: CatsCo's permit endpoint still refuses its absence. Enabling this
service does not start the delegated worker. Deployment/enablement must wait for
the trusted admission adapter and isolated acceptance.

The required dual-store contract now uses the actual CatsCo commit client for
all three actions and actual Cloud/CatsCo handlers in both directions over
verified TLS. CI pins the reviewed PR670 merge `1c4251293018d343f21c74d94358eab2decedab6`.
Both databases, Git and the
signed artifact are real; the human HTTP scenario uses actual admission routes.
Source probing is synthetic and older race scenarios still seed intent.

## Independent delegated worker lane

`SKILLHUB_PUBLICATION_DELEGATED_WORKER_ENABLED` defaults false and additionally
requires valid task budgets and `SKILLHUB_PUBLICATION_PUBLISHING_ENABLED=true`.
It does not require the service endpoint to remain enabled to recover a commit
already authorized. It does not request permits, plan versions or create intent.

The worker runs one delegated attempt at a time independently of legacy jobs.
Database leases coordinate multiple processes. Idle/error polls use the worker
interval (1–60000 ms); errors are redacted, and no in-memory retry loop resets
the three-attempt durable limit. Invalid optional configuration disables only
this lane. `--once` drains currently due tasks without waiting through backoff.

SIGTERM/SIGINT stops further claims and waits for the current fenced attempt.
Forced termination leaves its lease for a later process to recover. Stopping
an idle lane wakes its timer. Account tasks, held candidates, cancelled tasks
and completed/exhausted commits are not delegated work. No new migration or
production switch activation is included.

Unit tests cover defaults, invalid configuration, one in-flight claim, graceful
stop, error redaction and idle wake-up. Real PostgreSQL tests run two schedulers
against an expired lease and verify one version; the dual-store contract restarts
the scheduler after artifact interruption using the reviewed CatsCo client.
