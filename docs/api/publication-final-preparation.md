# Final publication package preparation

This is the first independently reviewable part of P2-B2, after PR27's shared
version reservations. It adds an **internal, side-effect-free** preparation worker
and an optional packager consistency check. It does not add a publish endpoint,
change task states, enable a production feature, or enforce new rules on legacy
callers. A `ready` task is still only a validated private candidate.

## Inputs and trust boundary

`runPreparePublication(input, limits, executionOptions)` accepts:

- `rawJson`: the exact private candidate request, as UTF-8 bytes or text.
- `candidateHash`: the candidate digest from validation, not the legacy content
  deduplication hash.
- `requestHash`: the exact request-byte digest from private task storage.
- `manifest`: the server-derived public manifest for the intended release.
- `identity`: the reserved `ownerId`, `uploadId`, `skillId`, `version`, and canonical
  ISO `releaseAt` from the future durable publication intent.

These inputs must come from internal task storage and authorized publication
logic. This function does **not** authenticate users, validate a database
reservation, derive a namespace, confirm a new version, or prove CatsCo Bot
ownership. The identity shape check is not an authorization check. The future
writer must do those checks before Git, and again before database commit.

The operation runs under the validation worker's timeout, memory and abort
budgets. Caller admission must remain held until worker termination. It parses
untrusted JSON/YAML/ZIP, but never executes uploaded code, calls a model or writes
to disk. `preparePublication` is the synchronous core for tests/isolated workers,
not an HTTP-event-loop entry point.

## Candidate and final material

1. Verify the original request bytes against the stored `requestHash`, revalidate
   the original candidate and check its exact semantic candidate digest.
   Invalid original `skill.json` cannot be hidden by generated metadata.
2. Keep the selected entrypoint. Update only the three top-level `skillhub_*`
   service fields in its parsed YAML/JSON frontmatter. Preserve all other
   frontmatter semantics (including `description`) and the runtime body.
3. Materialize the final files with the **same function** used by the packager.
   Legacy behavior removes basename `skill.json` files and normalizes root
   `SKILL.md` CRLF. Strict preparation explicitly rejects nested `skill.json`
   rather than silently deleting a possible runtime dependency. The root manifest
   is carried as signed package metadata, as in existing packages.
4. Validate the actual final public manifest and materialized file bytes again,
   with the same limits. Metadata growth can cause a previously acceptable source
   to exceed a limit. ZIP-to-files expansion must also fit the final JSON request
   budget; this version fails closed instead of silently raising that budget.
5. Check that metadata injection/normalization did not change non-service
   frontmatter semantics or the runtime body (apart from CRLF normalization).

Success returns the bounded final validation report in `body` and private
`prepared: {manifest, files, receipt}` alongside it. **Never serialize the whole
result to an HTTP response, public task view or log**: `prepared.files` contains
private candidate file bodies. Rejections have no prepared material. Unexpected
worker errors use a static 503 response rather than exception details.

## Receipt and packaging

The receipt binds the rule version, limit fingerprint, original request and
candidate hashes, final candidate hash, release identity, and a material digest
over the complete final public manifest plus each ordered path/size/file digest.
It is deterministic for fixed inputs; random validation report IDs are excluded.
Unlike the legacy content hash, a change to package metadata changes this digest.

`buildPublishedPackage({..., preparedPublication: receipt})` recomputes the exact
material after normalizing its input files, checks identity/rules/limits, and
rejects mismatches **before signing-key or artifact IO**. Omission retains legacy
behavior; explicit `null` is not an opt-out and fails closed. The receipt is an
internal consistency record, **not a signature, user approval or capability**.
It must never be accepted from an upload body as permission to publish.

## Remaining P2-B2 work

The follow-up [durable commit path](publication-task-commit.md) now supplies the
opt-in intent, worker recovery and atomic completion described below. Preparation
itself remains side-effect-free; production activation and cross-repository
identity/entry-point integration are still separate.

The next writer must persist the intent/receipt privately and atomically bind
them to the task's candidate revision, request hash and current authority. It
must commit Git from the prepared material, verify the Git tree, persist stable
scan/package identity, handle signing-key rotation and artifact recovery, fence
stale leases, define cancellation at the commit boundary, and atomically record
the package result plus task completion. Candidate expiry cannot erase an active
commit or rewrite a published result to expired.

Neither Git/DB crash recovery nor publication exactly-once behavior is provided
by this preparation module. All public writers must eventually enforce final
validation at activation; merely merging this internal prerequisite does not
make legacy HTTP publishing strict. Bot/chat delegation, automatic repair and
Chinese-guide generation remain separate later stages.

## Verification

`tests/integration/publication-prepare.test.js` covers original/final validation,
YAML block scalars and JSON headers, quoted/nested service fields, BOM/CRLF/custom
entrypoints, immutable source input, changed candidates, metadata growth, nested
file removal, tampered receipts/files/identities/limits, worker abort/timeout,
and a real signed artifact whose manifest/files exactly equal the validated
material. Existing public/private packaging and legacy validation tests remain
part of the full regression suite.
