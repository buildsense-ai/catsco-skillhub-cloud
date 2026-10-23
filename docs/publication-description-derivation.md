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
immutable and rejects cancelled, expired, or already-started delegated tasks.
