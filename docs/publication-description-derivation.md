# Internal description derivation adapter

`POST /api/skills/publication-descriptions/internal/derive` is a private,
service-to-service adapter for the future CatsCo `DeriveAndRetain` port.

The feature is disabled unless `SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_ENABLED=true`
and a dedicated `pubderive_` credential, HTTPS issuer/audience, and trusted proxy
list are configured. It never accepts browser cookies, CORS, account sessions,
or caller-supplied source bytes.

The request binds an `applicationId`, CatsCo `taskId`, original request/candidate
hashes, and the exact confirmed `SKILL.md` description proposal. Cloud reads the
retained CatsCo task candidate, re-runs the deterministic derivation, and stores
the derived bytes in `publication_description_derivations`. Repeating the same
application returns the same retained copy; changing any binding fails closed.

This lane does not change publication task state, consume model quota, publish a
package, grant authority, or modify the original candidate. The table is
immutable. Fresh derivation requires an unexpired held delegated source;
metadata-only replay can still return the historical receipt. Neither is an
authorization to consume or execute a retained copy.

## Private copy read/recovery

`POST /api/skills/publication-descriptions/internal/read` is additionally gated
by `SKILLHUB_PUBLICATION_DESCRIPTION_READ_ENABLED=true` (default false). It uses
the same dedicated service credential and HTTPS/host/proxy restrictions as
derivation. Browser sessions, cookies, Origin, CORS and public candidate URLs
are never accepted. The route is intercepted before the public CORS middleware.

The JSON request has exactly these fields:

```json
{
  "schemaVersion": 1,
  "applicationId": "pubdesc_<64 lowercase hex>",
  "taskId": "pubtask_<uuid>",
  "requestHash": "<original request sha256>",
  "candidateHash": "<original candidate sha256>",
  "proposal": {"relativePath":"SKILL.md","field":"description","entryIndex":0,"text":"Exact confirmed text"},
  "expectedReceipt": {
    "schemaVersion": "1",
    "algorithm": "skillhub-description-derivation-v1",
    "originalRequestHash": "<original request sha256>",
    "originalCandidateHash": "<original candidate sha256>",
    "validationDigest": "<validation digest>",
    "proposalDigest": "<proposal digest>",
    "limitsFingerprint": "<limits fingerprint>",
    "derivedRequestHash": "<derived request sha256>",
    "derivedCandidateHash": "<derived candidate sha256>"
  },
  "derivedBytes": 123
}
```

`expectedReceipt` is an object with exactly schemaVersion, algorithm,
originalRequestHash, originalCandidateHash, validationDigest, proposalDigest,
limitsFingerprint, derivedRequestHash and derivedCandidateHash. Every binding,
including byte count and the complete proposal, must match the retained row.
The request is bounded to 32 KiB and the returned copy to the configured request
byte limit. There is no write, INSERT, recapture, re-retention, publish, model
call or budget mutation on this route.

Successful responses are the exact retained bytes (`application/octet-stream`,
exact Content-Length, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`).
Errors are redacted JSON and contain no candidate, proposal or storage detail.
There is no base64/JSON reserialization of the returned private package request.
The caller must check the response size AND its SHA-256 against its stored
derivedBytes/derivedRequestHash before consuming any bytes.

Recovery verifies stored byte integrity, then rederives in a bounded worker from
the exact original candidate/report/proposal under the current validation rules
and limits. The resulting full bytes and receipt must match the retained copy;
a substituted but internally rehashed package is rejected. The original source
must still exist, be unexpired, delegated_pending and not have begun commit.
It is checked again after the worker. A missing/purged/cancelled/expired source,
changed rules/report or missing/corrupt copy fails closed. Recovery never falls
back to a newly captured source or a different application identity. Its shared
concurrency slot lasts through worker/SQL settlement AND response completion;
slow or disconnected consumers cannot free a still-busy worker slot.

This checks integrity, not CatsCo authority. A later CatsCo consumer must fetch
the immutable application from its store and check the current original human,
Bot/Owner/body/private task/cancellation/round and live Runtime source before
and after the call. This PR has no such production consumer and enables no
flag. Source checks here are point-in-time checks, not a lock spanning transport
or permission to resume a repair round. The original Skill and three-round
budget stay unchanged.

Tests include exact-byte recovery after a dropped HTTP reply with recreated
handlers/stores, immutable PostgreSQL rows, source expiry/cancellation, forged
binding/bytes, real verified HTTPS and default-off/browser rejection. PostgreSQL
tests require `SKILLHUB_TEST_DATABASE_URL`; skips without a DSN are not database
verification. The required CI integration job runs them against real PostgreSQL.

## Private derived-candidate validation report

`POST /api/skills/publication-descriptions/internal/validate` is a report-only
view of the same retained private copy. It requires the base derivation switch
and `SKILLHUB_PUBLICATION_DESCRIPTION_VALIDATION_ENABLED=true` (default false),
the dedicated peer credential, and the same HTTPS/host/proxy/browser restrictions.
It does not require enabling the octet read route or grant access to its bytes.

The request is exactly the read/recovery request above. The original candidate,
complete original report, confirmed proposal, full derivation receipt, derived
byte length and current limits must all match. The bounded worker rederives and
validates the exact retained package; the original source is checked again
afterward. This reuses the existing integrity proof rather than validating
untrusted caller bytes or treating the original rejected report as the result.

The JSON response contains exactly `schemaVersion: 1`, `applicationId`, `taskId`,
`derivedBytes`, `receipt` (the complete retained derivation receipt) and
`validation` (the standard complete validator report). The report's
`candidateHash` is the DERIVED candidate hash, its limits fingerprint matches
the receipt, and truncated reports are refused. No source bytes, private file
paths, proposal text, download URL or execution grant is returned. Failures use
the existing fixed redacted errors. The shared two-slot limit lasts until both
worker/SQL work and response delivery settle, including timeout/disconnection.

Validation is read-only and generates a fresh standard report ID. It retains
no report, changes no publication/repair state, and makes no model call. A
future CatsCo continuation must check current actor/Bot/Owner/body/private task,
exact current round/confirmation/application and live original Runtime source
before and after the peer request, then durably bind the accepted report at its
own state transition. A report ID/hash or a `passed` result alone cannot resume
`waiting_confirmation`, allocate a new round, reset the three-round budget or
publish. General private-candidate ancestry and round-2/3 derivation remain
follow-up work; this view only validates copies supported by the current
deterministic description derivation. No production switch is enabled here.

## Independent derived-candidate release plan

`POST /api/skills/publication-descriptions/internal/plan` additionally requires
`SKILLHUB_PUBLICATION_DESCRIPTION_PLAN_ENABLED=true` (default false), publication
tasks/publishing configuration, and the same service credential and transport
restrictions. Enabling the private read or validation routes is not required.

The request has exactly `copy` (the complete read request above),
`publicationReceipt` (the unchanged original delegated upload receipt), and
`confirmVersionPublish` (a boolean). The original task/request/candidate in both
references must match. The boolean is a version-policy input, never evidence of
human confirmation or permission to publish.

The planner verifies current Cloud publisher/profile/namespace authority, proves
the retained bytes by bounded deterministic rederivation, and runs the existing
draft/preparation worker against the DERIVED candidate. No package code runs.
It then locks and rechecks the original live task, publisher and exact copy,
reserves a public version, and retains one immutable manifest/identity/target in
`publication_description_release_plans`. Metadata counts toward the existing
global and per-owner task storage limits; quota errors roll back the version
reservation and plan together. No SQL lock spans worker execution.

The response has exactly `schemaVersion: 1`, `applicationId`, `taskId`,
`publicationReceipt`, `receipt` (the full derivation receipt), `derivedBytes`, and
`target` (the existing commit-target shape). The target's candidate hash is the
DERIVED hash; the original upload receipt retains the ORIGINAL hash. Neither
private bytes/proposal text nor manifest/identity internals are returned.

Same-input retries, including a committed plan whose HTTP reply was lost,
recover the same target/version after fresh integrity/authority/expiry checks.
Changed confirmation inputs or copy/receipt bindings fail closed. The task lock
and database guards exclude competing original-candidate plans in both orders.
Historical plans cannot be updated or deleted; expired/cancelled sources cannot
recover a currently usable plan. Migration 021 adds no backfill or feature flag.

This is planning only: no permit, commit record, job, model call, task/round
transition, original candidate rewrite or three-round budget reset. The old
commit coordinator still accepts ONLY the original candidate. A future CatsCo
consumer must bind this exact response to its durable application/acceptance,
current human/Bot/Owner/body/round/cancellation and live original Runtime source,
then obtain a distinct candidate-bound publication authorization. Do not pass a
derived hash through the old receipt/commit path. No production switch is enabled.

The required PostgreSQL suite covers concurrent planners/reconstruction,
immutable history and old-plan exclusion, cancellation/publisher changes during
verification, quota rollback, version confirmation, expiry and lost HTTP replies.
Local runs without a PostgreSQL DSN skip those cases rather than proving them.

## Independent derived-candidate release authorization (not publication)

`POST /api/skills/publication-descriptions/internal/authorize` is a separate
CatsCo-to-Cloud peer operation. It additionally requires
`SKILLHUB_PUBLICATION_DESCRIPTION_RELEASE_PERMIT_ENABLED=true` (default false),
the plan and derivation lanes enabled, and its own HTTPS peer credential. Its
exact JSON request contains only `schemaVersion`, `applicationId`, and the
unchanged `publicationReceipt`; Cloud obtains the target from its immutable
retained plan rather than trusting a caller-supplied target.

Before peer I/O, Cloud verifies the retained derived bytes and prepared target,
then durably writes a `pending` authorization row under the original task lock.
That pending row fences both the application cancellation adapter and direct
database cancellation. Cloud calls the fixed CatsCo HTTPS origin with the exact
entry, application and full retained target. A successful exact permit is
retained immutably and returned for recovery; retries after lost replies reuse
the same target and CatsCo's idempotent permit. Definitive denied/cancelled/
conflict replies become a terminal denied record; transport or storage failures
remain pending and retryable because the remote outcome may be unknown.

The route and its independent switch default off. It is service-only, rejects
browser credentials and untrusted transport, and makes no model call. This
authorization is still NOT a Cloud commit permit: no commit row, job, worker,
upload, public package, task completion or original-candidate mutation is
created. A later separately reviewed step must consume this exact derived
target, recheck authority/source, and atomically connect permit to publication.
