# CatsCo publication entrypoint delegation contract

Status: **proposed for cross-repository review, not an implemented API**.
This contract connects the existing Cloud publication tasks to CatsCo chats and
Bot workspaces. Merge approves the integration boundary, not production
enablement. All new routes, records, grants and events below require subsequent
implementation and tests. No model calls, billing, automatic repair or UI redesign
are introduced by this document.

Implementation note: CatsCo PR656 provides the service-only introspection
endpoint. Cloud's matching [internal client](publication-introspection-client.md)
and pinned HTTPS contract test are now implemented separately. No Cloud upload
route or worker calls that client yet; the association and commit/cancel protocol
below remains a prerequisite for activating delegated publishing. The
[publisher identity provenance](publication-publisher-identity.md) migration
records issuer origins for newly verified identities without silently adopting
historical UID-only mappings. Legacy binding and delegated intake remain separate
rollout prerequisites.

The [held delegated intake](publication-delegated-intake.md) now provides an
internal atomic association/outbox foundation and ordinary-session isolation.
It has no production caller, callback delivery or delegated commit worker;
historical identity binding and the cancel/permit protocol remain activation gates.

## Existing capabilities and gaps

The audit baselines are
[Cloud 02fe7d6](https://github.com/buildsense-ai/catsco-skillhub-cloud/tree/02fe7d66a1e3c1e90cf0afe1eee9651714359382),
[CatsCo bef6944](https://github.com/buildsense-ai/cats-company/tree/bef69445d5550cceafa8f25ea973101c07b61bb5), and
[XiaoBa a6154c4](https://github.com/buildsense-ai/XiaoBa-CLI/tree/a6154c4aa1882b0a1da620a312bad72077ce3143).

| Component | Existing code | Consequence for integration |
| --- | --- | --- |
| Cloud | `apps/api/publication-tasks.js`, `packages/publication-tasks/`, migrations 012 and 014 | Durable private candidates and recoverable publication exist; authentication establishes a Cloud account, not CatsCo Bot/chat authority. |
| Cloud identity | `synchronizeCatsCoPublisherProfile` in `apps/api/server.js` | CatsCo UID is verified against configured `/api/me`, then mapped to a Cloud user/profile. A username or namespace is not an identity key. |
| Cloud Bot auth | `packages/bot-auth/index.js` | Bot identity grants private Skill read/write scopes, not human publication authority. |
| CatsCo workspace routing | `server/thin_tool_rpc.go` | Existing owner/device/server-Bot guards are useful; pending RPCs are in memory with a default 120-second TTL, not durable publication jobs. Wiki access is not sufficient publication authority. |
| CatsCo Cloud access | `server/skillhub_marketplace.go` | Per-request human-token exchange checks returned UID and revokes the temporary session. This is not a background credential. |
| CatsCo chat startup | `webapp/src/views/tinode-web.jsx`, `webapp/src/utils/agent-task-topic.js` | Draft navigation and group creation exist, but do not provide publication-bound, idempotent task startup. |
| XiaoBa chat publishing | `src/tools/share-skillhub-skill-tool.ts` | The tool ignores its execution context and uses the legacy service. It must not be reused as proof of the current human's identity. |
| XiaoBa workspace publishing | `src/skillhub/local-share.ts`, `src/catscompany/skillhub-rpc.ts` | Owner/Bot checks exist, but malformed local Skills can fail before Cloud intake, and the legacy share operation holds a workspace lock across network work. |
| XiaoBa transport | `src/skillhub/client.ts`, `src/skillhub/service.ts` | Errors retain code/message, not full task reports; legacy `platforms: []` and content hashes cannot be copied into the strict candidate contract. |

These observations describe the integration gaps, not a finding that every legacy
caller is unauthenticated. Surrounding route guards remain necessary.

Existing Cloud wire formats remain defined by [validation](skill-publish-validation.md),
[private tasks](publication-tasks.md), and [publication commit](publication-task-commit.md).
In particular, a create response can be 201 with a **rejected** task; 202 and
`ready` never mean published. The proposed metadata below must not be inserted
into today's strict task-create body, which rejects unknown fields.

## Ownership and repository responsibilities

First-version delegated publication is initiated by an authenticated CatsCo human
who owns the selected Bot. The publisher is that human's mapped Cloud account,
not the Bot account, runtime device owner inferred from a local login, Skill
author text, or another participant in the conversation. Friendship and Skill
visibility grants authorize neither workspace export nor private report access.

| Fact | Authoritative component | Required check |
| --- | --- | --- |
| Human UID and account type | CatsCo authenticated request or live server-issued turn grant | Human active; never accept model-supplied identity fields. |
| Bot owner and runtime route | CatsCo database and registered runtime identity | Actor owns Bot; exact device/body/installation binding, not display name or active local Bot. |
| Conversation and user intent | CatsCo topic access and durable message/action record | Same human and Bot; owner-private destination before returning files or reports. |
| Cloud account and publisher namespace | Cloud verified CatsCo identity mapping | Stable issuer + UID mapping; active user/profile; no name-based account merge. |
| Local source and consistent copy | XiaoBa on the authenticated target runtime | Scoped local reference, source generation, file grants, path and byte limits. |
| Candidate, report and final package | Cloud | Recompute exact digests and validation; Cloud `published` is the final package result. |
| Repair conversation and event delivery | CatsCo durable orchestration | Same Bot/task; persistent association and deduplicated startup. |

A trusted XiaoBa `ExecutionScope` is a necessary local check, not a credential
Cloud can verify. CatsCo must issue a separate opaque publication context grant
for the authenticated live turn. Replayed transcripts, `legacy_context`,
`untrusted`, a bare Bot API key, and the existing service bearer cannot create
such a grant. A group conversation that cannot keep reports owner-private is
not an allowed automatic return destination; return a safe private-action prompt
without candidate/report details. Do not silently choose another topic or Bot.

## Durable identifiers and binding

CatsCo owns an `entryRequestId` and a durable entry record before asking the
runtime to upload. Browser retries use an account-scoped `requestId`; a chat tool
uses the server-issued turn/tool invocation identity. A repeated intent returns
the same entry. Different source, Bot or intent with the same key is a conflict.

| Field | Producer and meaning |
| --- | --- |
| `entryRequestId`, `requestId`, `entrypoint` | CatsCo; entrypoint is `workspace` or `chat`. Request IDs carry no authority. |
| `actorCatsCoUid`, `botUid`, `ownerUidAtCreation` | CatsCo; equality of actor and current Bot owner is rechecked for privileged operations. |
| `topicId`, `messageId`, `toolInvocationId` | CatsCo; chat fields are bound to trusted server records, absent for the original workspace click. |
| `runtimeBinding` | CatsCo-verified device/body/installation identity and route generation. A reconnect is not permission to use another device. |
| `sourceRef`, `workspaceGeneration` | Runtime-validated opaque local Skill or attachment reference. No arbitrary browser absolute path or URL. |
| `sourceSnapshotHash` | Digest of the captured candidate before repair, using the same candidate algorithm as Cloud. Null for unsafe/unreadable source; never fabricate one. |
| `candidateRevision`, `candidateHash` | Revision starts at 1; Cloud computes the canonical digest. Each future repair creates a new immutable candidate/task association. |
| `requestHash` | SHA-256 of exact candidate HTTP bytes for Cloud retry identity; distinct from semantic candidate hash. |
| `publicationTaskId` | Cloud; one immutable candidate task per entry revision, not a bearer capability. |
| `delegationId`, `authorityEpoch` | CatsCo durable grant record and revision, validated by Cloud through authenticated server-to-server calls. |
| `approvalId` | CatsCo evidence of a particular human action and exact approved facts, never a model boolean. |
| `eventId`, `eventSequence` | Durable CatsCo delivery identity and monotonic entry sequence, independent of model execution. |

Cloud stores the verified CatsCo issuer/UID, mapped owner/profile, entry ID,
revision, source digest, delegation ID and authority epoch alongside the task.
Unique `(issuer, entryRequestId, candidateRevision)` prevents duplicate tasks;
an existing association with different bytes or identity is 409. Database
migrations must enforce these constraints, not an in-process map.

Persist a Cloud-compatible Idempotency-Key per revision before the first upload;
retry with that key and the stored exact bytes. Cloud task acceptance and its
association-delivery outbox must commit atomically. CatsCo accepts a callback only
from the authenticated Cloud peer with matching entry/revision/binding; a runtime
cannot attach an arbitrary task ID. If the callback/response is lost, reconcile
the same association before enabling publish, with no network call inside either
database transaction. Retention must preserve association and replay evidence
for the lifetime of an accepted commit; an expired entry is not auto-recreated.

There is no editable candidate route in the current Cloud API. Future repair
must use revision compare-and-swap, invalidate old approvals and ensure only the
active revision can request publication. Do not edit PR25/29 snapshots in place.

## Proposed credential and control protocol

Use **opaque, short-lived, purpose-scoped grants with online introspection**,
backed by durable CatsCo authorization records. Do not put a long-lived human
JWT, Cloud cookie, Bot API key, or a reusable all-publishing service secret in a
job, chat, URL or model prompt. Browser closure/logout does not cancel an accepted
intent; explicit cancellation, account disablement, ownership loss or delegation
revocation prevents new privileged work before the commit boundary below.

CatsCo and Cloud use dedicated, independently provisioned server authentication
for grant introspection and task coordination. The credential authenticates the
calling service, not the publisher: every request additionally needs a matching
live delegation. Use configured HTTPS peers, reject redirects and caller-supplied
authority URLs, pin the expected issuer/audience, and redact authentication data.
Credential provisioning/rotation is an implementation rollout prerequisite,
not something this documentation change performs.

Logical operations below name the required protocol, **not existing URLs**:

| Operation | Caller and receiver | Bound inputs and result |
| --- | --- | --- |
| `createEntry` | Human WebApp or authenticated live chat runtime to CatsCo | User action/turn, Bot and source reference; creates durable entry plus outbox record after owner checks. No source bytes in the outbox. |
| `captureCandidate` | CatsCo to the exact runtime | Entry and limited source grant; runtime captures a private copy and returns source digest or bounded local failure. |
| `issueUploadGrant` | Bound runtime to CatsCo | Entry, active revision and exact request hash; returns opaque Cloud-audience upload grant. |
| `introspectGrant` | Cloud to CatsCo | Grant, action, request hash and entry binding; checks live authority, returns canonical identity and scope. |
| `acceptCandidate` | Bound runtime to Cloud | Grant header plus unchanged P1 candidate body and Idempotency-Key; atomically saves verified binding with the private task. |
| `bindCloudTask` | Authenticated Cloud to CatsCo | Entry/revision/task/hash receipt; idempotent association. Lost delivery is retried from durable state. |
| `readTask` | Authenticated human through CatsCo to Cloud | Owner-scoped entry/task reference; bounded private status/report, no candidate bytes. |
| `requestPublish` | CatsCo to Cloud | Current task/revision/hash, publish intent and required approval evidence; Cloud preflight/identity checks still apply. |
| `authorizeCommit` | Cloud worker to CatsCo | Exact task, candidate, frozen publisher/version intent and authority epoch; durable one-task commit permit as defined below. |
| `cancelEntry` | Authenticated owner through CatsCo to Cloud | Idempotent cancellation; reports pending/confirmed/too-late honestly. |

Proposed grant lifetime is at most 120 seconds. Upload grants bind the exact
request hash, operation, entry, revision and runtime identity; retries may only
replay those facts. They grant no listing, candidate download, commit, visibility
change or billing. Cloud validates on use, not only when issued. A stale/expired
grant may be replaced by CatsCo only after rechecking current authority and the
same durable intent; it cannot create a new intent or transfer identity.

The bounded candidate bytes travel directly over a dedicated authenticated HTTP
upload, not through thin-tool RPC or a WebSocket event. Store the byte-identical
request privately for lost-response retries. Before copying, enforce existing
source/file access rules; after copying, release workspace locks before upload,
Cloud polling or model work. Cloud intake limits, per-owner storage quotas and
execution budgets still apply. Grant issuance and status polling also need
per-account/entry limits, finite timeouts and bounded retry backoff.

Cloud needs a separate delegated authentication adapter and persisted origin
binding. Existing plain session task routes remain account APIs, but must not
allow a session-only caller to publish a **delegated** task around its CatsCo
approvals or authority checks. Neither the service bearer nor private Bot auth
is upgraded into human publication authority. Read/cancel access remains limited
to the mapped human; runtime grants only expose the one authorized task/action.

## Authority changes and commit recovery

Recheck CatsCo authority at entry creation, snapshot dispatch, upload grant use,
publish acceptance and immediately before commit authorization. Cloud continues
its own active-account/profile/namespace checks before and inside final commit.
If CatsCo cannot verify authority, retry boundedly or show authority unavailable;
do not treat an outage as approval, formatting failure or a reason for legacy
fallback. Rejected authority requires renewed human action, not automatic account
substitution.

The cross-service protocol must define one ordering point, rather than claiming
a distributed database transaction exists. Proposed ordering:

1. CatsCo serializes `authorizeCommit` against entry cancellation/revocation and
   current owner/account checks. It durably records one immutable permit for the
   exact Cloud task/hash/publication intent. Before that permit, revocation wins
   and no new commit can start.
2. The permit is the delegated **authorization** boundary. Once issued, that
   already-authorized publication may finish or recover even if the browser
   closes or CatsCo later revokes the entry. Revocation never authorizes another
   task/revision. The UI must show this as commit authorized, not promise that
   cancellation or ownership transfer can undo it.
3. Cloud persists the permit with its transition to `committing`, serialized
   against Cloud cancellation on the task row. If cancellation wins locally,
   the unused permit cannot resurrect that task. Lost permit responses are
   queried/replayed with the same commit key, never granted to a replacement task.
4. CatsCo cancellation racing an issued permit stays pending until Cloud answers
   cancelled or commit-started/published; do not report cancelled from the CatsCo
   record alone. After the existing Cloud commit boundary, use its recoverable
   task/checkpoint protocol, never start a fresh publish operation.

Permit issuance does not reserve a second version or skip final package checks.
Account/profile changes within Cloud can still block completion as today. A
durable permit is an internal recovery record, not a bearer token, and requires
authenticated server retrieval. No network call runs while holding a workspace
lock or a Cloud database row lock. This ordering and crash cases must be reviewed
and tested before enabling delegated commit; today's Cloud worker implements
only Cloud-side authority checks.

Runtime offline before a snapshot gives `waiting_runtime`; reconnection may
resume only the same authorized binding. A changed installation/workspace
requires recapture and renewed source confirmation, not name-based lookup.
Once an immutable candidate has been safely uploaded, ordinary runtime offline
status does not by itself block Cloud validation/publication of that copy.
Ownership/binding changes are authority changes; never rebind a desktop Agent
to a cloud Bot as a recovery action.

## Reports and entry state

CatsCo entry state describes orchestration, not a second package truth:
`waiting_runtime`, `capturing`, `uploading`, `local_rejected`, `tracking_cloud`,
`needs_user_action`, `authority_blocked`, `cancel_pending`, `cancelled`.
When tracking Cloud, retain the original `cloudState` and safe Cloud report;
only Cloud `published` supplies final Skill/version/checksum. `local_rejected`
can exist with a null `publicationTaskId`.

Malformed metadata must still have a safe intake path: a list item with missing
description cannot disappear merely because legacy `can_share` is false. The
new operation captures readable bounded files without requiring a valid Skill
manifest, then lets Cloud reject them. Local unreadable/unsafe/oversized inputs
retain a bounded error associated with the entry; unsafe bytes are not imported
or executed just to obtain a Cloud task. ZIP attachments remain isolated from
the running Skills tree. Only trusted attachment/file grants allow local access.

Adapters preserve Cloud's existing report schema and `repairPolicy`, not a new
free-form exception dump. Forward allowlisted code/message, report/rule IDs,
coverage, candidate digest, issues and nextAction. Keep the current 50-issue limit,
48 KiB entire-validation-response budget and a maximum 64 KiB single-entry transport envelope;
truncate optional presentation detail without changing rejection semantics.
Use the existing controlled location/index fields, never echo arbitrary paths,
source excerpts, credentials or raw upstream HTML. No shared cache; responses
are private and no-store.

Handle 201 rejected-task responses as well as bounded 422 validation/preparation
responses. Distinguish 400/413 invalid transport or budget, 401/403 identity,
404 disabled/missing/other-owner, 409 stale state/confirmation, 429 throttling
and 503 infrastructure. Infrastructure errors never trigger model repair.
Unknown errors become a safe generic error with a correlation ID. Query the
entry/task after an uncertain response rather than treating a timeout as failure
and creating a new publication.

## Confirmations and subsequent repair integration

An explicit publish intent authorizes the named Skill copy, not arbitrary new
content. Existing new-version confirmation remains required. CatsCo stores
approval evidence from an authenticated user action bound to actor, entry,
candidate revision/hash, intended Skill identity and the displayed action.
Cloud's current `confirmVersionPublish` boolean is only a downstream parameter;
the delegated adapter must derive it from valid evidence, not model arguments.
For candidate or intended-version changes, re-evaluate the existing version
confirmation policy; never recycle approval for different facts.

Missing-description drafts need separate approval of the exact draft digest
before writing even to the candidate copy. The future repair engine enforces
allowed format-only diffs and a maximum three repair rounds in durable state;
validation retries, event redelivery and process restarts do not reset that
budget. Semantic, identity or security changes stop. Repair never writes the
running Skill, changes BotDefinition, installs the published result, calls legacy
finalize, or switches the current Agent.

Workspace failure remains visible after refresh. A later `startRepair` action
will create/reuse one owner-private repair conversation for the same Bot and
entry. CatsCo needs a durable outbox plus idempotent conversation creation/start;
navigation to an empty composer is insufficient. Its startup event carries task
references and safe summaries, not credentials/source. Deduplicate delivery and
model execution separately. Chat failures return through trusted tool results
or queued events at a safe turn boundary, not injected into an active tool
message sequence. Deleted/inaccessible topics retain owner-queryable status but
receive no automatic replacement chat. This stage does not implement that engine.

## Implementation sequence and rollout gate

| Order | Change | Exit evidence |
| --- | --- | --- |
| 0 | Review this three-repository identity/task contract | Agreement on issuer mapping, owner-only context, scoped grants, permit/cancel ordering and private reports. No live switches. |
| 1 | CatsCo durable entries, trusted turn/action binding, scoped delegation and cancellation/permit records | Real database uniqueness and race tests; authenticated peers; no frontend publishing activation. |
| 2 | Cloud delegated adapter, binding migration, introspection and worker commit permit integration | Reject session bypass and wrong-scope tokens; replay/crash/revocation tests; ordinary Cloud task regression suite. |
| 3 | XiaoBa candidate snapshot/upload adapter and structured reports | Both input sources, malformed Skills, source isolation, trusted context and reconnect tests; no automatic repair yet. |
| 4 | CatsCo minimal two-entrypoint integration and persistent status | Owner-private chat results and workspace reports; end-to-end tests against isolated accounts/runtime. |
| 5 | Repair assistant, candidate revisions, exact draft confirmation and durable new-chat startup | Three-round budget, no semantic auto-edits, one-time startup and safe event delivery. |
| 6 | Asynchronous Chinese guide and optional author-managed images | Separate model/billing contract; publisher pays; author edits cannot be overwritten. |

Deploy schemas and inactive compatible services first. Negotiate an explicit
delegated-publication capability across all three components, including report
budgets and rule version; never infer support from a version string or HTTP 200.
Only activate for isolated test accounts after orders 1–4 are complete. Unsupported
or stale clients show an upgrade/action-required error; an enabled delegated
entry must never fall back to legacy share on timeout, rejection or missing grant.
Unrelated model switching, private backups and installed Skills must keep working.

Production enablement is a separate gate after cross-repository tests and user
acceptance. Rollback disables new admission/repair without erasing durable tasks,
dropping safety checks or restarting accepted commits as legacy jobs. In-flight
commits retain a compatible recovery worker. This PR changes no flags, runtime
code, database schema, credentials or server configuration.

## Required acceptance matrix

| Scenario | Expected result |
| --- | --- |
| Owner publishes via chat and workspace | Same verified human mapping; private copy; exact final Cloud result; no installation or binding change. |
| Cached Cloud account differs from current CatsCo human | Fail closed; no task under the cached account. |
| Friend/wiki viewer, Bot token or model supplies an owner UID | Cannot create delegation or export workspace; no private report leak. |
| A user owns two Bots with identical Skill names | Exact selected Bot/source binding preserved throughout upload, repair and reconnect. |
| Group/forwarded/replayed chat context | No automatic owner-private data disclosure or reconstructed authority. |
| Wrong audience, action, hash, runtime, entry, epoch or expired grant | Reject; no legacy fallback or changed identity. |
| Response lost after upload/association/permit issuance | Same entry/revision/task/permit recovered; no extra version or new publish intent. |
| Page closes or RPC TTL expires | Durable accepted work remains queryable; no dependence on the pending RPC map. |
| Missing description or local pre-Cloud failure | Persistent report even without Cloud task; exact draft approval needed before future repair writes. |
| Malicious ZIP/path, oversized source, prompt injection in Skill | Bounded rejection; no execution, original mutation, authority change or arbitrary report content. |
| Runtime offline or source changes while capturing | Wait or conflict safely; no switch to local device/another Bot. Workspace lock not held across HTTP/model waits. |
| CatsCo authority lost before permit | No commit; honest blocked state. |
| Authority lost/cancel requested concurrently with permit | Test both serialized orders; show pending/too-late accurately; no permit reuse by another task. |
| Worker dies between permit issuance and Cloud commit | Recover exact permit or preserve Cloud cancellation; no duplicate Git/package/version writes. |
| Session-only publish called for delegated task | Cannot bypass delegation, current revision or approval evidence. |
| 201 rejected, 422 report, 503 outage | Distinct outcomes preserved; never label accepted/ready as published or outage as format failure. |
| Repeated repair-start/event delivery and stale draft approval | One conversation/run; no reset of repair budget; reject approval for changed content. |
| Existing legacy/account publication, model switch and private backup | Existing regression suites pass; no new workspace lock or identity coupling. |

These are requirements for subsequent implementation PRs, not test results from
this documentation-only contract.
