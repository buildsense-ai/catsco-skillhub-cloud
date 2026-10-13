# Skill publication preflight

This is the first stage of publishing validation. It checks an uploaded candidate and returns a bounded, structured report. It **does not publish**, save a candidate, reserve a version, install a Skill, edit source files, create a task/conversation, run uploaded code, or call a model.

The existing `POST /api/skills/share` pipeline is unchanged. Enabling this endpoint does not enable enforcement on that pipeline. A later task-based publication change must revalidate the actual candidate and the final derived package before publishing; a caller-supplied report or hash is never authorization to publish.

## Configuration and rollout

`SKILLHUB_PUBLISH_VALIDATION_ENABLED` defaults to `false` in **all** environments. Both routes return 404 while disabled. Deploying this PR does not enable preflight in production. Use isolated test accounts/packages for opt-in testing.

| Setting | Default |
| --- | --- |
| `SKILLHUB_PUBLISH_VALIDATION_MAX_CONCURRENT` | 2 per API process, including request reads and authentication |
| `SKILLHUB_PUBLISH_VALIDATION_REQUESTS_PER_MINUTE` | 30 per authenticated actor per API process |
| `SKILLHUB_PUBLISH_VALIDATION_MAX_REQUEST_BYTES` | 75 MiB encoded HTTP JSON |
| `SKILLHUB_PUBLISH_VALIDATION_READ_TIMEOUT_MS` | 15,000 including authentication |
| `SKILLHUB_PUBLISH_VALIDATION_WORKER_TIMEOUT_MS` | 10,000 |
| `SKILLHUB_PUBLISH_VALIDATION_WORKER_MEMORY_MB` | 512 MiB V8 old-generation limit per worker |

Existing upload limits (`uploadMaxBytes`, `maxFiles`, `maxSingleFileBytes`, `maxExpandedBytes`, `maxPathLength`, `maxPathDepth`) also apply. Defaults: 50 MiB ZIP, 500 entries, 5 MiB/file, 100 MiB expanded, 180 path characters, 12 path segments. The encoded JSON limit is separate from archive and expanded bytes. Rules responses show actual effective values.

Protocol ceilings: 50 issues, 48 KiB for the **entire pretty-printed JSON response**, JSON/YAML depth 64 and 100,000 nodes. Parser work runs in a disposable Worker, terminated on deadline or disconnect. Worker heap limits are not a total process RSS guarantee: input/output Buffers additionally remain bounded by intake budgets and admission limits. No unlimited worker queue is created.

CPU work is stopped before releasing its slot. An authentication database query cannot be cancelled by aborting HTTP; its admission slot remains reserved until that query settles, while the client can already receive the timeout response. No global database configuration is changed.

## Authentication

Both endpoints use the same authenticated session/service-agent mechanism as the existing share endpoint. Unauthenticated users cannot trigger file decoding. Request byte and connection/admission budgets apply before parsing, including during authentication. A successful preflight does not establish Skill ownership, authorize publication, prove redistribution rights, or authorize billing.

There is no API for retrieving another caller's report or files. `reportId` is a diagnostic identifier, not a bearer capability or persisted task ID. Responses use `Cache-Control: no-store`. A caller that needs durable results must wait for the later publication-task API.

## Endpoints

### Read rules

`GET /api/skills/publish-validation/rules`

Returns `schemaVersion`, `ruleVersion`, `profile`, effective `limits`, `execution` budgets, coverage disclaimers, and capabilities:

```json
{"preflight":true,"publicationTasks":false,"automaticRepair":false}
```

### Validate candidate

`POST /api/skills/publish-validation` with `Content-Type: application/json`:

```json
{
  "source": {
    "type": "files",
    "files": [
      {"path": "SKILL.md", "content": "---\nname: example\ndescription: Read user-selected documents.\n---\n# Example\n"}
    ]
  },
  "manifest": {"displayName": "文档读取", "version": "1.0.0"}
}
```

Alternatively use `source: {type: "zip", archiveBase64: "..."}`. File entries require exactly one string `content` or canonical padded `contentBase64`; an explicitly empty string is permitted. Objects are never stringified into file content. Unknown source/file/request fields are rejected. `form` is an alias for `manifest`; supplying both is an error. Inputs are not read from remote URLs or server paths.

Top-level JSON, skill.json and explicit JSON frontmatter reject duplicate keys (including escaped aliases), unsupported numeric values, comments and trailing commas. Invalid Unicode input is not silently decoded into a different document. Files may be arbitrary bytes via Base64; metadata text must be valid UTF-8.

| HTTP | Meaning |
| --- | --- |
| 200 | `{"validation": report}`; complete checks in this profile, no blocking issues |
| 422 | `{"error":{"code":"skillhub.publish_validation_failed","message":"...","validation":report}}`; package/frontmatter rejected |
| 400 | Invalid request JSON, fields or encoding; safe `error.code/message` |
| 413 | Transport, file, expansion or parser budget exceeded; not an invitation to retry unchanged files indefinitely |
| 401/403 | Authentication/authorization failure; do not start file repair |
| 429 | Actor rate limit |
| 503 | Busy, timeout or execution failure; never reported as format rejection or passed |

Old clients may only retain `error.code/message`. Rich report rendering and persistence are separate client work. `200 passed` is not `published`; existing share `200 existing`, `200 requiresConfirmation` and `201 accepted` keep their old meanings.

## Report

Fields: `schemaVersion`, `ruleVersion`, `profile`, `reportId`, `outcome` (`passed|rejected`), `coverage` (`complete|partial`), `candidateHash`, `limitsFingerprint`, `issues`, `truncated`, `nextAction`.

Each issue contains a stable `code`, `category` (`format|package_safety|compatibility`), `blocking`, `location`, Chinese or static safe explanatory `message`, and `repairPolicy`. Locations use a zero-based file entry index, known safe metadata filename where applicable, and a controlled field name. Arbitrary filenames are not echoed because even relative filenames can contain secrets. ZIP reports before file extraction use the central-directory entry index; after extraction the index refers to the emitted file list, excluding directory entries.

No file excerpts, raw exception messages, credentials, absolute paths or executable patches are returned. Output ordering prioritizes blocking issues. Truncation does not change the rejection result; unsafe intake returns `partial` and a null candidate hash. `complete` only means this profile was fully checked, **not** functional testing or comprehensive security auditing.

Missing description returns `metadata.description_missing`, `repairPolicy=confirmation_required`, and `nextAction=review_report`. P1 creates no draft and cannot return `confirm_draft`. Future repair must bind approval to the actual draft, actor, task and candidate revision. `repairPolicy` is guidance, never authorization to edit files. No issue in P1 automatically executes a repair.

## Metadata and format rules

- Validate original skill.json even when an explicit manifest overrides it. Invalid raw values cannot be hidden by normalization or replacement.
- Explicit manifest/form takes precedence for packaging/display parameters; packaged metadata is next, then documented defaults. The entry's own name/description are validated independently: external descriptions cannot fill them in. Display names, registry IDs and runtime names need not be identical.
- Resolve entrypoint from explicit `entrypoints.skillFile`/`skillFile`, then packaged equivalents, otherwise root `SKILL.md`. Conflicting aliases within one source are rejected. A unique valid selected entry can coexist with nested example SKILL.md files. No wrapper stripping, renaming or arbitrary multi-Skill selection occurs.
- YAML and explicit `---json` frontmatter are supported with nonexecuting parsers. Unknown executable language engines/tags are rejected. CRLF, UTF-8 BOM, quoted values, multiline descriptions and unknown extension fields are supported. Complex repeated/cyclic YAML references may require the author to expand them; no model is called to do so.
- Name and description must be nonempty strings. Name cannot have surrounding whitespace. Long descriptions are not truncated to fit the legacy manifest's 800-character display field.
- `skill.json`, version defaults, images, Chinese introductions and optional tags are not mandatory additions to a valid runtime Skill. This preflight does not rewrite a running file to supply them.
- Paths must already be safe relative POSIX paths. Traversal, absolute/Windows-style paths, links, exact duplicates and file/directory prefix collisions are rejected. No dangerous file is silently removed to pass.
- Target defaults follow the existing manifest: Windows/macOS/Linux. Explicit `platforms`, then `runtime.platforms`, select the targets; empty/unknown values are invalid. ASCII case/prefix collisions on insensitive targets and Windows forbidden paths are rejected. Potential Unicode equivalence is a warning, not a claim to fully emulate every filesystem. Linux-only packages are not rejected for ASCII case differences alone.
- Shell/network commands and environment-variable examples are not blocked by legacy scanner keywords. P1 adds no secret classifier or license verifier and makes no claim of absolute safety.

## Supported ZIP subset

Ordinary stored/deflate ZIPs with UTF-8 filenames and optional 12/16-byte data descriptors. Checks include local/central header agreement, bounds, actual output budget, CRC, duplicate/prefix conflicts, special file types and compressed-input consumption. No filesystem extraction occurs.

Encrypted, ZIP64, multidisk, SFX, non-UTF-8 names, alternate Unicode-path extra fields, hidden gaps/unindexed records and unsupported algorithms are rejected. A user can resupply a supported ZIP or use `files`; rejection never executes an importer or changes the original archive. This stricter profile applies only to the new endpoint, not the old share decoder.

## Exact candidate identity

`candidateHash` is SHA-256 of a versioned canonical structure containing sorted raw path/size/per-file-SHA256 entries plus explicit manifest/form semantic values. Paths/object keys use UTF-8 byte ordering; files retain original bytes including line endings and skill.json. Transport ordering, ZIP metadata and compression level do not affect identity. The domain is `skillhub-publish-candidate-v1`.

This deliberately differs from legacy `contentHash`, which excludes skill.json and normalizes root SKILL.md line endings. Neither digest is authorization. Effective processing limits have a separate fingerprint; rule version is returned separately. Revalidation must bind all relevant facts rather than trusting a caller's prior report.

## Verification and subsequent work

New tests cover pure rules/reports, adversarial ZIP input, route authentication, resource limits, timeout/cancellation, no storage side effects and ZIP/files equivalence. Existing real-database publishing tests must also run in CI; skipped local DB tests are not evidence of compatibility.

Next stages add durable candidates/tasks, final publish enforcement and two-client report propagation, then bounded repair in copies and chat handoff. Chinese guide generation and account billing remain separate work. This PR must not be presented as delivering those stages.
