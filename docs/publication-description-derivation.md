# Private description candidate derivation

This is a deterministic byte transformer, not a public repair endpoint or an
execution/confirmation grant. No API, RPC, model tool, worker scheduler or
production caller invokes it. It does not write to PostgreSQL, the filesystem,
the retained source or the Bot workspace, call a model, reserve a version,
consume/reset a repair round, or publish anything. Existing feature flags and
ordinary tools are unchanged.

## Input and output

`runDerivePublicationDescription(input, limits, {signal, timeoutMs, memoryMb})`
runs in the existing validation worker isolation and waits for worker termination
before releasing admission, including cancellation and timeout. The synchronous
`derivePublicationDescription` is for that worker and bounded tests only.

The input has exactly five fields:

- `rawJson`: original retained request string or UTF-8 bytes (files or ZIP).
- `requestHash`: SHA-256 of those exact request bytes.
- `candidateHash`: original validator candidate identity.
- `validation`: the complete original persisted rejected report, never a model
  summary or browser replacement. This report must match revalidation under the
  current rules/limits, except for the fresh random report ID.
- `proposal`: exact `{relativePath:"SKILL.md",field:"description",entryIndex,text}`.
  The index selects the original candidate's files array, not YAML documents or
  a filesystem path. Text is nonblank, well-formed UTF-8, at most 8192 bytes, with
  no ASCII control characters except tab/CR/LF. Whitespace is not trimmed.

Only a complete, untruncated report whose sole blocking issue is exactly that
`metadata.description_missing` selector is eligible. Any package-safety issue
(even nonblocking), other blocking issue, changed limits/rules/evidence or
unsupported selector fails closed. `skill.json` and custom/nested entrypoints
are deliberately not supported; the current validator has no applicable
confirmed-missing-description rule for them.

The result uses a safe public `body.validation` and **private** `derived`:

```text
derived.rawJson                    independent files request
derived.receipt.originalRequestHash
derived.receipt.originalCandidateHash
derived.receipt.validationDigest    exact retained report, including report ID
derived.receipt.proposalDigest      exact selector/text
derived.receipt.limitsFingerprint
derived.receipt.derivedRequestHash
derived.receipt.derivedCandidateHash
```

Receipt schemaVersion is `"1"`; algorithm is
`skillhub-description-derivation-v1`. `validationDigest` and `proposalDigest` are
SHA-256 of `domain + NUL + canonicalJSON(value)`, using UTF-8 bytewise sorted
object keys and original array order, with domains `algorithm + ":validation"`
and `algorithm + ":proposal"`. They are **not** CatsCo's Go-JSON confirmation
key or repair-evidence hashes and are not interchangeable with those identities.

The derived bytes and receipt are deterministic for the same retained input,
report, proposal and limits. Revalidation generates a fresh public report ID;
that ID must not be used as an idempotency key or proof of repair progress.
The private bytes must never be included in a public task projection or log.
Errors return only fixed safe codes/messages, no partial bytes or parser errors.

## Byte and semantic proof

All inspection uses the existing bounded strict JSON/YAML parser. The shared
frontmatter reader exposes the original header's byte range; only that range is
replaced. BOMs, opening/closing delimiters, line endings outside the header and
the runtime instruction body remain byte-for-byte intact. All non-description
metadata must compare deeply equal after re-parsing and the resulting description
must equal the exact proposal, including leading/trailing whitespace and CR/LF.

Every other file is emitted as the exact original bytes, without packager
normalization, filtering, execution or metadata injection. Paths, order and the
explicit manifest/form are preserved. ZIP is decoded through the existing bounded
intake and emitted as a new files request; the original archive is never changed.
The complete new request must pass the real validator under the same limits.

`assertPublicationDescriptionDerivation(receipt, candidate, input, limits)`
re-derives from the retained input and rejects any receipt or byte substitution,
including rehashed alternatives. It proves integrity only, not authorization.

## Required integration (not implemented here)

The future trusted CatsCo executor must independently:

1. Load the exact immutable confirmed draft and original receipt/report from
   server-owned storage; never interpret `confirmed:true` or possession of a
   digest as approval. Check the current active original human, Bot owner/body,
   private same-Bot repair conversation, cancellation, task and original round.
2. Revalidate live Runtime source under its workspace fence; a prior read is not
   ongoing write authority. Source edits/deletion/replacement stop the operation.
3. Bind one immutable derived copy to a persisted application identity including
   the exact confirmation. Recover the same copy after restart/lost reply; do not
   overwrite the source, release `waiting_confirmation` or reset three-round
   accounting by clearing a result. Quotas/retention must cover the copy.
4. Recheck authority before accepting/continuing the result and use independent
   model-call reconciliation before any paid execution. An uncertain paid call
   must not be repeated merely because a lease expired.

Until that integration is implemented and reviewed, this module is intentionally
unreachable from publication requests. This change is not the complete automatic
repair workflow or a new source/file-write permission.

## Verification

`node --test tests/integration/publication-description-derivation.test.js`
tests actual transformed bytes with the real validator and isolated worker,
YAML/JSON, null/blank/missing fields, BOM/CRLF, ZIP, binary attachments,
prototype-looking data, inert scripts, exact text, strict parser failures,
manual/safety stop conditions, budget growth, evidence/receipt substitution and
timeout/cancellation. These are real parsing/byte tests, not paid-model,
PostgreSQL-application or production end-to-end acceptance.
