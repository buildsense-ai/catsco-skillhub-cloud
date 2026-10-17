# CatsCo publisher identity provenance

Cloud records the verified CatsCo service origin alongside newly created CatsCo
publisher identities. This is a prerequisite for delegated task association,
not an upload route, grant, human-account check or commit permit.

## Identity creation and compatibility

Both `/api/auth/catsco-exchange` and `/api/auth/catsco-profile-sync` verify the
token with the server-configured `/api/me` authority, then pass that exact
canonical origin to `claimCatsCoPublisherIdentity`. Body fields such as
`issuer`, `catsCoIssuer`, `baseUrl`, usernames and owner hints cannot select it.
No credentials are stored in `catsco_issuer` or returned as profile metadata.

Migration 015 adds nullable `publisher_profiles.catsco_issuer`. New identities
created by verified sync store this origin in the same transaction as their
user and profile. Existing UID and namespace advisory locks serialize duplicate
and conflicting first claims. The global UID uniqueness rule remains: Cloud
does not become a multi-issuer identity provider. A known UID bound to another
origin returns `409 catsco.publisher_issuer_conflict`, before changing metadata
or issuing a session. Renaming a user at the same origin preserves identity.

The database trigger prevents changing a bound issuer, UID or Cloud owner,
including through generic profile upserts. Normal display-name, namespace,
contact and status edits remain possible. Sync does not reactivate disabled
accounts or profiles. Existing local HTTP authentication remains compatible;
its recorded HTTP origin cannot match delegated publishing's pinned HTTPS issuer.

Historical profiles retain NULL provenance, including after login or profile
sync. Today's configuration does not prove which issuer created a historical
UID. Ordinary legacy account behavior is retained; no current endpoint promotes
these profiles into verified delegated publishers. An evidence-backed legacy
binding procedure remains required before enabling delegated publication for
existing accounts. Do not bulk fill this column from the current environment,
contact text, display names or synthetic email addresses.

## Requirements for delegated task intake

The later adapter must require a non-NULL exact issuer and UID match with the
pinned introspection result. It must lock and recheck the active user/profile
and publisher identity in the task transaction, persist the binding with the
task and callback outbox, and reject missing or conflicting provenance. Looking
up by UID alone, accepting a session alone or reading this column once outside
the transaction is not sufficient authority. The internal
[held intake](publication-delegated-intake.md) now performs these transactional
checks for new issuer-bound profiles, without exposing an API. Human account type, current Bot
ownership, revision, byte hashes and final commit permission remain CatsCo
protocol checks. Legacy identity binding and delegated commit authorization
are not implemented by the held intake.

## Deployment and rollback

Apply migration 015 before deploying this binary. The schema readiness check
requires the column; do not remove the migration/trigger on rollback. An old
binary does not enforce issuer conflicts at login, so it is not a safe rollback
while accepting CatsCo authentication under a changed authority. Keep the new
guard or disable those authentication entrypoints during such a rollback.
Old binaries may create additional unbound identities; these must remain
ineligible for delegated publication. No delegated publication flags are enabled.

## Verification

HTTP regression tests cover configured origin propagation, ignored forged
issuer hints, and conflict responses without sessions or profile changes. Real
PostgreSQL tests cover concurrent first claims, cross-issuer races, persistent
same-issuer renames, legacy NULL preservation, immutable identity updates,
disabled status preservation and applying migration 015 to preexisting rows.
The existing integration suite and pinned CatsCo HTTPS contract must also pass.
These checks are not end-to-end runtime capture or publication acceptance.
