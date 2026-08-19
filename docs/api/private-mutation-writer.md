# C1 -> SkillHub Private Mutation Writer

This is an internal, dormant endpoint for the CatsCo mutation coordinator. It
is separate from `/api/bot/private-skill-packages`, which remains the existing
Bot workspace backup/restore API used by the first-phase runtime.

## Availability

The endpoint is disabled unless both settings are explicitly enabled:

```env
SKILLHUB_MUTATION_WRITER_ENABLED=true
SKILLHUB_MUTATION_WRITER_SECRET=<dedicated service secret>
```

The secret is service-to-service authentication only. It must not be exposed
to the WebApp, XiaoBa client, or Bot API key clients. The current endpoint is
not wired into the C1 coordinator or runtime activation path yet; enabling it
alone does not turn on `shared_live` or change Skill injection.

## Request

`PUT /api/internal/bot/private-skill-versions`

```json
{
  "mutationId": 42,
  "grantId": "smg_...",
  "botUid": 1001,
  "localSkillId": "review-pr",
  "name": "PR review",
  "actorUserUid": 7,
  "sourceTopicId": "p2p_7_1001",
  "sourceMessageId": 99,
  "runtimeBodyId": "body-prod",
  "clientRequestId": "request-42",
  "operation": "create",
  "candidateContentHash": "<sha256 of canonical file metadata>",
  "candidateSizeBytes": 1234,
  "files": [
    {
      "path": "SKILL.md",
      "size": 1234,
      "sha256": "<sha256>",
      "contentBase64": "..."
    }
  ]
}
```

`replace` additionally requires `expectedPreviousHash` and an exact
`beforeReference` with `source=skillhub`. The server verifies the candidate
file hashes, aggregate content hash, and candidate size. Candidate size means
the sum of canonical workspace file bytes, not JSON or HTTP request size.

The envelope is persisted with a request fingerprint. Repeating the same
`MutationID` and facts returns the same immutable version facts. Reusing a
`MutationID` with changed facts returns `409 MUTATION_IDEMPOTENCY_CONFLICT`.

## Response

```json
{
  "mutationId": 42,
  "reference": {
    "source": "skillhub",
    "skillId": "review-pr",
    "version": "v_<opaque-version>",
    "contentHash": "<sha256>"
  },
  "afterReference": { "...": "same reference" },
  "gitCommitSHA": "<40-char SHA>",
  "gitRepositoryId": "git_<id>",
  "gitTreeSHA": "<40-char SHA>",
  "gitTag": "v<version>",
  "replayed": false
}
```

The logical `skillId` in this response is the C1 `localSkillId`. The physical
private package and Git repository remain opaque and isolated by CatsCo
authority plus real Bot UID. Runtime download/activation must use the future
mapping path; this PR does not expose a new client download route.

## Failure and recovery

The mutation row is kept pending when Git, artifact, or database activation
returns an uncertain/transient error. A retry with the same `MutationID`
reuses the reservation and Git tag. Only request conflicts and immutable fact
conflicts are terminal. The Git writer also takes a cross-process filesystem
lock per bare repository; the existing in-process queue remains as a fast path.

