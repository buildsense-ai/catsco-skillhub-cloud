# Skill presentation foundation

This is M1a of the SkillHub marketplace redesign. It adds **version-bound display metadata**, not new executable Skill content. It does not call models, spend account quota, change BotDefinition, publish packages, install Skills, or access Bot files.

M1b will add controlled raster attachments. This foundation deliberately rejects image URLs, asset IDs, HTML/CSS fields and arbitrary template definitions. The document/image/generic examples below are plain text data for first-party illustrations; they are not uploaded pictures or verified test outputs. AI generation, CatsCo WebApp wiring, remote source preview and historical backfill are separate changes.

## Rollout and compatibility

1. Apply additive migration `008_skill_presentations.sql` with `npm run db:migrate`.
2. Deploy API/worker normally. Neither the existing readiness check nor old catalogue reads depend on the new tables. Old `/api/skills`, share, download and private-Skill APIs retain their response contracts.
3. In production the new routes default **off**. Enable `SKILLHUB_PRESENTATIONS_READ_ENABLED=1` when ready for integration. Enable `SKILLHUB_PRESENTATIONS_WRITE_ENABLED=1` separately for human author/admin editing. Read must be enabled for write access.
4. Roll back by disabling write/read flags or reverting application code. Retain the additive tables; do not drop history or modify signed packages. No client permission is removed by disabling this feature.

The one intentional old-search correction is that an empty query no longer defeats category filtering. The legacy default remains 30 results and retains platform-compatible older-version discovery. The new catalogue is opt-in and always classifies the latest published version, never an older compatible release in its place.

The authentication prerequisite pins `/api/auth/catsco-exchange` to the server's `SKILLHUB_CATSCO_BASE_URL`, just like profile sync. Client `baseUrl`, `httpBaseUrl` and `user` hints no longer supply identity authority. Redirects during token verification are refused. Configure the actual CatsCo authority on each environment; legitimate tokens still use the same login/session flow. This does not rotate keys, change UID/namespace mappings, or invalidate current sessions.

## Public reads

| Method and route | Result |
| --- | --- |
| `GET /api/catalogue/categories` | `schemaVersion: 1`, the eight canonical category IDs and labels |
| `GET /api/catalogue/skills` | `{skills, total, nextCursor, categoryCounts}` |
| `GET /api/skill-presentations?skillId=author%2Fname&version=1.0.0` | `{presentation: null}` when that published package has no confirmed introduction; otherwise its public presentation |

Catalogue query parameters: `q`, `search_mode` (use `name` for existing WebApp name-only semantics), `category`, `platform`, `agent_version` (currently advisory as in the original search), integer `limit` (1–100, default 30), and opaque `cursor`. A blank or malformed explicit limit is invalid. Existing publisher-specific skill IDs remain independent even when visible names match.

For the new catalogue, a published presentation's primary category wins. Without one, use the first recognized canonical category already in the manifest; legacy categories such as `office`/`legal`, or no category, fall back to `other` until an author/admin categorizes them. Do not rewrite the manifest or guess a semantic mapping. Each Skill contributes to exactly one primary category. The original registry still returns its original categories.

`categoryCounts` covers all query/platform matches before category filtering and pagination, not just the current page. `total` is the selected category's total. Each new-page entry has `primaryCategory`; a confirmed introduction adds `presentationSummary: {revision, summary, primaryCategory}`. The complete content is fetched only through the presentation detail endpoint.

The cursor binds normalized filters, page size and a dataset fingerprint. Changes to versions/categories/confirmed introductions return HTTP 409 (`catalogue.cursor_stale`); different filters return 409 (`catalogue.cursor_filters`). Restart at page one on either error. Invalid cursor encoding or structure returns 400. It is an integrity/consistency token, **not** an authorization token or a persistent snapshot of private data. Enumeration is currently in-memory over the same public version set as existing search; the page response is bounded, not the database working set. Future catalogue-scale work can move ranking/counts to indexed storage.

Public presentation fields: `schemaVersion`, `skillId`, `version`, `sourceContentHash` (nullable for legacy packages), `revision`, `content`, `origin` (`author` or `admin`), `exampleDisclosure: "illustrative_not_tested"`, `publishedAt`. These describe the exact package version; there is no implicit cross-version fallback. Unknown/private/unpublished/yanked versions return 404. Withdrawing an introduction leaves the package published and returns `presentation: null`.

All presentation responses are `no-store`. Private drafts, editor identities, administrator reasons and revision history never appear in public detail or catalogue responses. All data strings are **plain text**; WebApp must escape them with React text rendering, not `dangerouslySetInnerHTML` or raw-HTML Markdown. Every example must visibly say “示意 / 非实测”.

## Author and administrator editing

Editing requires a valid human SkillHub session (including one obtained by CatsCo exchange). The shared Agent secret and Bot API key do not grant access. A Bot's owner cannot edit a Skill belonging to another publisher. The database compares the exact package version's `owner_user_id` with the session actor; it never authorizes by displayName, namespace or request-supplied UID. Nonowners see 404. An administrator editing someone else's introduction must supply a nonblank `reason`, retained privately.

| Method and route | Purpose |
| --- | --- |
| `GET /api/skill-presentations/draft?skillId=author%2Fname&version=1.0.0` | Owner/admin view of draft and last public content; initial `revision` is 0 |
| `PUT /api/skill-presentations/draft` | Save a draft with `expectedRevision` and `content`; does not alter public content |
| `POST /api/skill-presentations/publish` | Confirm the server-stored draft at the expected revision |
| `POST /api/skill-presentations/unpublish` | Withdraw only the introduction, preserving the draft and package |

Writes require `Content-Type: application/json`; any supplied Origin must exactly match the public API origin or an explicit configured allowed origin. Keep CORS origins restricted. Server-to-server calls may omit Origin but still need the human session. No browser-supplied publisher, payer, source hash or confirmation body content is accepted.

Draft body example:

```json
{
  "skillId": "author/document-reader",
  "version": "1.0.0",
  "expectedRevision": 0,
  "content": {
    "schemaVersion": 1,
    "summary": "读取你提供的文档，并整理摘要和待办事项。",
    "primaryCategory": "documents",
    "tags": ["摘要", "文档"],
    "scenarios": [{"title": "整理会议记录", "description": "根据文档内容梳理已明确的行动项。"}],
    "steps": ["提供可访问的文档", "说明需要提取的内容", "检查结果"],
    "example": {"kind": "document", "input": "会议记录示例", "output": "摘要与行动项示例"},
    "requirements": ["需要有权访问源文档"],
    "limitations": ["示例非实测，请核对原文"],
    "details": "作者可以补充纯文本说明。"
  }
}
```

Publish/unpublish body contains only `skillId`, `version`, `expectedRevision`, and optional admin `reason`. Successful mutations increment one shared head revision; `published.revision` independently identifies the last public snapshot. This conservative CAS serializes save/publish/unpublish and rejects stale or duplicate writes with 409 (`presentation.revision_conflict`). After uncertain network results, re-read before retrying. There is no automatic duplicate publication or package version bump.

Public provenance comes from the draft's writer: admin confirmation of an author's draft remains `author`; author confirmation of an admin-written draft remains `admin`. A new author edit creates an author-origin draft without silently relabeling the already-public content.

Limits: request 48 KiB; summary 240 UTF-16 units; up to 5 tags of 40; 3 scenarios (title 80, description 400); 6 steps of 400; 8 requirements and 8 limitations of 300; example input/output 2000 each; details 8000. Strings are trimmed; unpaired surrogates/control characters and unknown fields are rejected. `schemaVersion` must be 1. Image upload and AI provenance fields are intentionally unsupported here.

## Storage and verification

`skill_presentations` is keyed by the existing `skill_versions.id`, with private draft content/origin, confirmed content/origin and revisions. `skill_presentation_revisions` stores immutable action history. No install manifest, checksum, signature, source commit, content hash, file path or package bytes are changed.

Writes lock the exact package-version row, verify availability and ownership, compare revision, and persist head/history/audit in one database transaction. Audit failure rolls back everything. The general audit contains action/revision/content digest and a hashed IP, not draft text or free-form admin reason. Deleting an underlying package through existing account cleanup cascades its dependent presentation records rather than blocking deletion; deleting an editor does not erase another owner's introduction or audit identity.

Verification commands:

```sh
node --test tests/integration/catalog-search.test.js tests/integration/catsco-profile-sync.test.js tests/integration/skill-presentation-api.test.js
npm run db:migrate
npm run test:ci
```

The last two require an isolated PostgreSQL test database with both `SKILLHUB_DATABASE_URL` and `SKILLHUB_TEST_DATABASE_URL` configured. Existing GitHub CI provisions PostgreSQL 16. Store tests cover first-write races, draft/publish races, privacy, exact-version ownership, audit rollback, immutable package rows, provenance, yanking, database constraints and account deletion compatibility. Without the test database, PostgreSQL tests are skipped, not counted as database validation.
