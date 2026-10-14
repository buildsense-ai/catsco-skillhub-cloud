# Durable publication task commit

This completes the Cloud commit path after PR27's version reservations and
PR28's final-package preparation. Migration `014_publication_commits` is required
before deploying API/Worker. The new path is separately **default-off**. It does
not connect CatsCo chats, authorize access to a Bot's workspace, install a Skill,
run uploaded code, repair descriptions, or generate a Chinese guide.

## HTTP contract

With both `SKILLHUB_PUBLICATION_TASKS_ENABLED=true` and
`SKILLHUB_PUBLICATION_PUBLISHING_ENABLED=true`, an authenticated **Cloud account
session** may call:

```text
POST /api/skills/publication-tasks/{taskId}/publish
Content-Type: application/json

{"candidateHash":"<digest from task>","confirmVersionPublish":false}
```

The body is limited to 4096 bytes, uses strict JSON, and accepts only those two
fields. Account/namespace, candidate bytes, manifest, version allocation, upload
ID, package/scan IDs, receipts and timestamps are server-derived. Service bearer
credentials and other accounts cannot publish or discover this task. A live
`ready` candidate, an active Cloud user and an active publisher profile are
required. The namespace is derived with the existing publisher slug convention.

The task ID is the publication idempotency key. Accepted requests return 202
with a task and `replayed` flag; **202 is not published**. Repeat the same body
after a lost response. Concurrent acceptance reserves one upload/version. Once
any historical version/reservation/legacy queued job occupies the Skill, a new
task must explicitly set `confirmVersionPublish:true`; otherwise 409
`skillhub.publication_task_confirmation_required` leaves the task ready. The
accepted boolean and candidate hash cannot be changed by replay. New tasks are
distinct publication intents, not a content-deduplication API.

GET/list retain private task ownership and no-store responses. `capabilities.publish`
indicates state eligibility when the feature is on; authority checks still run
on the action. Published results expose only `skillId`, `version`, `packageId`,
`checksumSha256` and `publishedAt`, never local paths, candidates or leases.
`published` records a past successful publication, not current catalogue
availability: yanking later does not rewrite history, and replay does not unyank.

## State and cancellation

| State | Meaning | Cancellation |
| --- | --- | --- |
| `ready` | Candidate validation passed | Allowed |
| `publish_queued` | Intent accepted or transient retry queued | Allowed only before the first commit boundary |
| `publishing` | Worker is preparing and validating final material | Allowed before the boundary |
| `committing` | Receipt is durable; Git/artifact/DB work may have started | 409 `publication_task_commit_started` |
| `publish_failed` | Preparation, authority, or commit needs attention | Allowed only if no durable commit receipt exists |
| `published` | Package, scan and task result committed together | Rejected; this is not a yank endpoint |

Cancellation and entering commit serialize on the task row. Whichever wins
determines the outcome; cancelled work cannot enter commit. After entering
commit, a client must inspect/retry the same task rather than assume cancellation
can erase already-started writes.

## Recovery and authority

Acceptance stores the private manifest and immutable release identity with the
shared version reservation in one transaction. Each worker rechecks exact saved
request bytes, candidate digest, final package and preparation receipt. It checks
the active user/profile/namespace before entering commit and again under row
locks in the final package transaction. A profile/namespace change stops the
attempt; it never silently redirects publication to a different publisher.

Workers claim finite leases and renew them while working. Every state/checkpoint
write and final completion is fenced by the live token. Git commands for this
path receive an abort signal when work loses its lease or exceeds
`SKILLHUB_PUBLICATION_COMMIT_TIMEOUT_MS` (default 300000 ms). Repository locks are
not released until the spawned process closes. Legacy callers retain their
existing no-signal behavior. The deadline is not a guarantee that filesystem or
database operations are synchronously cancelled.

Manifest derivation, final preparation and the advisory text scanner all run in
isolated workers with the configured validation time/memory/abort budgets. The
scanner annotates risks under existing policy; it is not execution of uploaded
code or a comprehensive security audit.

Immutable Git tags accept only the exact same tree. Git contains the prepared
files plus canonical root manifest. The signed artifact contains exactly the
validated manifest/files. A private checkpoint records the selected package and
scan; replay verifies its Git identity, artifact length/checksum and material
instead of resigning it. Before a checkpoint exists, a crash/key rotation may
leave an unreferenced artifact and recovery may select a newly signed artifact;
there is still only one final database publication. No version slot is recycled.

The package row, scan row and task result are saved in the **same transaction**.
A stale lease, authority failure or scan insertion failure rolls them all back.
Legacy store callers cannot commit a task-owned upload without atomic task
completion. Existing Skill visibility/grants are preserved by version creation.

Transient failures retry up to three worker attempts with a five-second backoff.
This is infrastructure recovery, **not the later three-round Skill repair loop**.
After `publish_failed`, repeating the accepted publish request explicitly resumes
the same intent after rechecking authority. No semantic changes or new version
are introduced by retry. If rules/material change, missing/corrupt artifacts,
revoked identity, or storage exhaustion prevent safe recovery, the task fails
closed and needs operator attention. Receipt conflicts are not automatically
rewritten to match a new rule implementation.

## Retention and quotas

Before the commit boundary, normal candidate expiry and metadata retention still
apply. Once a receipt exists, incomplete work (including terminal publish failures)
retains its candidate and intent for recovery even past those dates. It continues
to consume task and byte quotas; it is not silently garbage-collected. Successful
completion clears candidate bytes and retains result metadata for at least the
configured retention period after completion. Normal maintenance can then purge
it. Reservations remain independent and permanent.

Intent, receipt and checkpoint sizes are accounted in `commit_bytes` under the
same global intake lock used for candidate quota enforcement. No second durable
copy of prepared file bodies is stored. Unreferenced Git/artifact garbage
collection is outside this change.

## Activation and rollback

Do **not** enable the publishing flag on production as part of this merge.
CatsCo/XiaoBa identity delegation and both entry-point adapters must be reviewed
and tested first. A Cloud session proves only Cloud ownership of an uploaded
candidate, not a human's authority over Bot files or a particular conversation.

Before activation, deploy every API/Worker writer and migration 014, drain the
legacy public publishing queue, and verify the integration in isolation. When
publishing is enabled, `/api/skills/share` returns a compatible 409 code/message
requesting the task workflow. Uncommitted legacy queue jobs are blocked from
writing Git/catalogue entries; previously committed legacy jobs may finish their
idempotent acknowledgement. Private backup, download and model-switch routes
are unchanged. Do not enable publishing with tasks disabled.

After activation, rollback must quiesce **all public publishing** before changing
flags/binaries. Turning the publishing flag off reopens the legacy HTTP writer;
that is not an acceptable safety bypass. Do not roll old workers onto live new
commit states. Preserve additive tables/checkpoints/reservations and resume with
a compatible build. Pausing workers must not delete incomplete candidates.

## Verification

`publication-commits.test.js` runs real PostgreSQL transactions and real Git/signing
for authenticated HTTP publication, concurrency/replay, explicit confirmation,
crashes after Git/artifact/checkpoint, stale leases and cancellation, atomic
rollback, publisher revocation, byte tampering, cross-account access, quota
rollback, expiry/retry, private visibility and yank preservation. A non-database
test verifies that aborted Git releases its lock before a later writer proceeds.
