# Private publication validation tasks

P2-A makes validation candidates and results durable. It does **not publish a Skill**. A `ready` task only means its saved candidate passed the current validation profile. No package, version reservation, Git tag, legacy job, repair conversation, model call or billing operation is created. Final publication and cross-entrypoint version coordination belong to P2-B; CatsCo/XiaoBa integration follows separately.

## Enablement and identity

Apply migration `012_publication_tasks`, then opt in using `SKILLHUB_PUBLICATION_TASKS_ENABLED=true` on API and Worker. Default is false in every environment. Invalid configuration fails only this feature closed (API 503; task Worker disabled); it must not stop legacy API/Worker operation. Missing schema returns safe errors, not automatic runtime DDL. The P1 preflight switch is independent. Existing `/api/skills/share`, Bot binding, model switching, private backup and installed Skills are unchanged.

Every route requires an authenticated **Cloud account session**, with an active Cloud user. A service-agent bearer alone is insufficient. Owner identity comes from authentication, never from request JSON. A task ID is not a capability. Read, list and cancel are owner-only; neither shared Skill access nor administrator role bypasses this boundary. No source download route exists in P2-A.

This does not establish CatsCo human account type, current Bot ownership, conversation authorization, or continuous upstream CatsCo revocation. Those require the later trusted delegation contract. Existing chat tools and workspace RPCs are not silently migrated. Do not use the new endpoints to authorize remote filesystem access.

Acceptance authorizes only background validation of the uploaded copy. No token/cookie is saved in the task. Logout does not cancel accepted work (CatsCo's proxy revokes its temporary session after each request). Workers check Cloud account activity before validation and in the fenced completion transaction. Cancel is the explicit way to stop a task; cancellation cannot terminate an already-running validation computation instantly, but prevents its result being committed. There are no publication side effects to roll back.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/skills/publication-tasks` | Validate intake and persist a private task |
| `GET /api/skills/publication-tasks` | Latest 100 owned task summaries, newest first, without reports or files |
| `GET /api/skills/publication-tasks/:id` | Owned task status and bounded validation result |
| `POST /api/skills/publication-tasks/:id/cancel` | Idempotently cancel and remove saved candidate bytes |

Create uses the same JSON `source` plus optional `manifest`/`form` body as P1, and a required `Idempotency-Key` header (8–128 ASCII letters, numbers, `_` or `-`; use a random UUID, not a credential). Explicit owner/Bot/task-state fields are rejected. It inherits P1 byte/read/parse/Worker budgets. Intake is checked in a disposable Worker before persisting any source bytes. Files are never executed.

The idempotency identity is `(authenticated account, key, SHA-256 of exact HTTP body bytes)`. Exact retries return the same task with `replayed:true`, without rerunning intake parsing. Reusing a key with different bytes returns 409, including equivalent JSON with different spacing or equivalent ZIP compression. The separate semantic `candidateHash` retains P1's exact files + explicit manifest contract; neither hash substitutes for authorization. Concurrent identical requests resolve to one task transactionally. A disconnected/timed-out response may have committed: retry with the same bytes/key, or query the owned list; do not invent another key.

| Response | Meaning |
| --- | --- |
| 202 `{task,replayed:false}` | Safe valid intake stored; background revalidation queued, **not published** |
| 201 `{task,replayed:false}` with state `rejected` | Rejection report persisted; no publication |
| 200 `{task,replayed:true}` | Existing task, including cancelled/expired tasks within retention |
| 400/413 | Malformed request or input budget exceeded; no task created |
| 401/403 | Authentication failure/inactive owner, not a formatting defect |
| 404 | Disabled feature, unknown route/task, or another account's task |
| 409 | Key reused with different bytes |
| 429 | Per-account request limit or retained-storage quota |
| 503 | Invalid feature configuration, capacity, database or validation execution failure |

Tasks expose `id`, `state`, `candidateHash`, `candidateAvailable`, `validation` (the P1 `{status,body}` result), optional `errorCode`, timestamps and `capabilities:{publish:false,repair:false}`. They never expose raw source, account ID, request key/hash, storage path, lease token or credentials. List summaries omit `validation`. Responses use `Cache-Control: no-store`; unknown exception details are redacted. P1's 48 KiB result cap leaves headroom below existing clients' 64 KiB error-body budget for the individual-task envelope.

## Lifecycle and recovery

Valid intake is `queued → validating → ready/rejected`. Syntax/format rejections are immediately retained as `rejected`. A complete, bounded candidate may be kept for future repair integration; a partial/unsafe rejection retains only the bounded report, never the uploaded bytes. Invalid transport JSON, oversized input and infrastructure errors do not create records.

The raw candidate and metadata commit together in PostgreSQL, with no partial filesystem directories or orphan file references. Background validation checks raw byte length/hash and reruns P1 on saved bytes with current rule/processing limits. It checks the semantic candidate hash again on success. `ready` never means the final derived package was validated: P2-B must revalidate the real final package before publication.

Tasks have at most three **validation execution attempts**, unrelated to the future three model-repair rounds. `FOR UPDATE SKIP LOCKED` plus a unique claim token and deadline prevent concurrent ownership. Expired claims are reclaimable; the old claim cannot complete after lease expiry, cancellation, candidate expiry or replacement. Infrastructure failures back off five seconds; the third failed/lost attempt becomes `failed`. A stale Worker may finish CPU work but cannot overwrite the current task. No persistent model call or publishing side effect is in this worker.

The task Worker runs alongside, not inside, the legacy queue. Optional task-store errors are caught so the legacy loop continues. The loop alternates one legacy job with one validation task; when enabled and busy, the legacy queue can wait an additional validation duration (normally bounded by the 10-second Worker timeout plus database work). This is not a promise of zero performance impact. The feature has separate HTTP admission/rate buckets using P1's configured execution budgets. Slow authentication/database work keeps its admission slot until the real operation settles even if the HTTP response times out. Task write transactions have local 5-second lock and 10-second statement timeouts.

## Retention and quotas

| Environment setting | Default |
| --- | --- |
| `SKILLHUB_PUBLICATION_TASKS_MAX_TASKS` | 10,000 retained records globally |
| `SKILLHUB_PUBLICATION_TASKS_MAX_TASKS_PER_OWNER` | 100 retained records per account |
| `SKILLHUB_PUBLICATION_TASKS_MAX_STORED_BYTES` | 2 GiB candidate bytes globally |
| `SKILLHUB_PUBLICATION_TASKS_MAX_STORED_BYTES_PER_OWNER` | 256 MiB candidate bytes per account |
| `SKILLHUB_PUBLICATION_TASKS_CANDIDATE_TTL_MS` | 7 days |
| `SKILLHUB_PUBLICATION_TASKS_RETENTION_MS` | 30 days |
| `SKILLHUB_PUBLICATION_TASKS_LEASE_MS` | 30 seconds, must exceed validation timeout + 5 seconds |

Quotas and idempotency insertion are checked under one short database advisory lock across API processes. Cancellation frees source bytes but retains the task record/quota slot and idempotency evidence. Expiry is enforced on queries and Worker writes even before physical cleanup. Expired candidates are cleared and reports retained; after retention the entire record is purged and the old request key may be reused. Clients must not automatically replay old intents after retention.

Cleanup handles batches of at most 500 records during intake and once per minute in an enabled Worker. An intake failure rolls back its transaction, including cleanup, so **enable task processing on the Worker as well as the API**; intake alone is not a reliable garbage collector. These are eligibility deadlines, not guaranteed deletion times: disabled/offline Workers or a backlog delay physical deletion. Re-enable maintenance to clear the backlog; this touches only the new table, never installed Skill files or legacy uploads. Retention must exceed candidate TTL. Defaults are initial operational budgets, not permission to raise them unboundedly.

## Acceptance and remaining work

Tests cover session-only authentication, private task lookup, exact retries/conflicts, storage limits, durable HTTP retries after API recreation, Worker revalidation, cancellation races, account deactivation, three lost attempts, stale claim fencing, candidate tampering, expiry and cleanup. PostgreSQL cases must run in CI; local skipped tests are not passes.

P2-B must provide owner/profile/namespace revalidation, version reservations shared with legacy publication, deterministic recovery after Git/artifact writes, atomic result/version completion, final derived-package validation and inherited current visibility. This PR does not add unused publish/repair endpoints or promise those guarantees early. Further candidate revisions, draft confirmations and Bot/conversation delegations belong to the next contracts; do not mutate P2-A's saved snapshot in place.
