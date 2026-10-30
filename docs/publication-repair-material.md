# Private original-candidate material read

This is the Cloud half of the M3 restricted repair material path after CatsCo
#831/#833/#836. It reads **already retained original candidate bytes**, never a
live Bot Skill, a derived copy, a caller path/URL or a newly captured package.
It performs no model request, repair round, description confirmation, report
regeneration, file write, task transition or publication. Later-round material
ancestry is not implemented by this original-candidate lookup.

## Service boundary and rollout

`POST /api/skills/publication-repair/internal/material` accepts exactly:

```json
{"schemaVersion":1,"receipt":{"schemaVersion":1,"entryRequestId":"pubentry_...","candidateRevision":1,"acceptanceEpoch":1,"requestHash":"...","sourceSnapshotHash":"...","requestBytes":123,"delegationId":"pubgrant_...","idempotencyKey":"pubcandidate_...","taskId":"pubtask_...","eventId":"pubevent_..."}}
```

The receipt is the existing original acceptance receipt, not an upload token or
model authorization. No actor, payer, Bot, model, description, round, path or URL
override is accepted. The peer lane is reserved before account/CORS routing.
Session cookies, browser Origins, account/upload credentials and non-POST
methods cannot read private material. Query strings and alternate paths are
rejected. Dedicated credential syntax is `pubmaterial_` plus 64 lower hex
characters; do not reuse it as a session, upload, commit or other service secret.

All five `SKILLHUB_PUBLICATION_REPAIR_MATERIAL_*` settings are independent of
description derivation and model execution. `ENABLED` defaults to false;
`ISSUER`, `AUDIENCE`, `PEER_SECRET`, `TRUSTED_PROXY_ADDRESSES` must be explicitly
configured. Both origins must be strict distinct HTTPS origins. Direct TLS or
an explicit trusted proxy with exactly one `X-Forwarded-Proto: https` and the
configured audience Host is required. Untrusted forwarded headers never grant
TLS. No production values or deployment are changed by adding this interface.

The paired CatsCo material client/controller is still separate work. It must
authenticate the original current human/Bot/private task, validate the exact
pending lease or read-recovery state, and verify the live Runtime source
**before and after** this Cloud read. Cloud cannot know CatsCo ownership or
Runtime state. An accepted receipt or successful byte read never authorizes a
model call, confirms a draft or grants publication. Never expose raw output in
a browser, model tool, user error, task/report projection, audit field or log.

## Database evidence and current Cloud authority

The reader validates original receipt syntax and freezes it before awaiting
storage. It locks the task row for share, then uses a new statement snapshot
after the lock wait to check **every** retained receipt field, configured peer
issuer/audience and `authority_kind=catsco` via delegation and outbox joins.
It requires a current active user and publisher profile with the original
profile ID, namespace, CatsCo UID and issuer. Historical report access is not
current material-read authority.

Only unexpired `delegated_pending`, non-cancelled tasks with no commit or
delegated permit are eligible. Missing/purged candidate bytes, mismatched
byte counts or more than 32 MiB fail closed; the SQL predicates bound bytes
before returning them. Task/user/profile share locks serialize reads with
cancellation/commit and publisher changes until transaction end. A second
database-clock check rejects expiry during processing. This is point-in-time
Cloud authorization, not distributed atomicity with CatsCo/Runtime or the
entire network response; already transmitted bytes cannot be recalled.

The reader copies the retained buffer, checks its exact SHA-256 against
`requestHash`, checks the full retained original rejection report against
`sourceSnapshotHash`, and requires complete/non-truncated rejection. It does
not run the validator again, create a new report ID, or treat rejection as
permission to automatically repair. Hashing the upload proves byte identity,
not safety; the future bounded material parser must independently validate
the candidate structure/hash and prepare a suitable limited model projection.
Package code/instructions are never executed by this read operation.

## Bounds and recovery

Success is exactly the original bytes with `application/octet-stream`, exact
`Content-Length`, `Cache-Control: no-store` and `nosniff`. Responses contain no
JSON wrapper, provider options, tokens, or replacement receipt. The future
client must enforce HTTPS peer pinning, no redirects/proxies/compression,
exact size/hash, deadline, and no disclosure of partial bodies/errors.

Requests are strict UTF-8 JSON, at most 4096 bytes with duplicate/unknown fields
rejected. The handler has a 15-second complete budget, two in-flight slots and
one fixed 60-per-minute bucket; it never creates rate buckets from caller data.
SQL has 3-second lock and 5-second statement budgets. Slots remain held until
both actual storage work and response transmission settle, even on timeout or
disconnect. Abandoned SQL cannot create unbounded concurrent reads. SQL/report
exceptions become static errors with no private text or cause.

There is no server retry or side effect. A lost response is an unavailable
observation; the trusted caller may make a new **read** under fresh current
authority checks, never infer permission to rerun a paid model. Reads across
process restart return the same immutable original bytes if still authorized,
or deny; cancellation/expiry must not restore material or allocate a task.

## Verification

Unit/HTTP tests exercise default-off configuration, dedicated peer/TLS/Host
boundary, strict input, receipt copying, hash/size/report mismatch, passed and
truncated reports, expired reads, cancellation, two-slot abandoned-work bounds,
shared rate limits, and no writes. Mandatory CI explicitly requires a real
PostgreSQL DSN and runs the material suite again: real TLS response loss and
reconstructed reader, exact receipt/peer mismatch, current publisher changes,
expiry/cancellation and task-lock ordering in both directions. Local skips
without the DSN are not database evidence. Runtime and paid-model behavior are
not claimed by these Cloud-only contracts.
