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
