# Delegated publication commit coordination

The internal Cloud coordinator joins an accepted CatsCo delegation to the
existing recoverable publisher. It does not expose an HTTP route, register a
scheduler, accept browser-supplied proof, or enable a production flow.
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
dual-store test uses the reviewed CatsCo PR666 handler over verified TLS and
actual Cloud intake/plan/worker code. It drops a permit reply, reopens the CatsCo
adapter, publishes one signed package after an injected interruption, and checks
both cancellation orderings. Human admission and Runtime probe/capture are
test-seeded, not claimed as deployed user experience.

Remaining work includes authenticated plan/status/execution service adapters,
trusted human admission, durable dispatch, Runtime capture/upload, and private
user-visible progress. Only after isolated cross-repository acceptance should
the production switches be considered. Bounded repair and Chinese guide/model
billing are later milestones, unchanged by this commit layer.
