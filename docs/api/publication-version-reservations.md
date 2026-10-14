# Public publication version reservations

This is P2-B1, the shared version-allocation prerequisite for durable publication.
It changes the existing share writer but does **not** turn P2-A `ready` into
`published`, add a task publish endpoint, enable strict final-package validation,
or implement publication lease/crash recovery. Those remain P2-B2.

## Allocation and existing callers

After the existing content-deduplication and new-version confirmation checks,
`POST /api/skills/share` reserves a slot under a PostgreSQL per-skill transaction
lock. Occupied slots include all historical versions (including yanked), all
reservations, and old `publish_skill_version` jobs in any state. Repeating the
internal upload ID returns its allocation; different owner/skill/requested
version conflicts. This is not HTTP request idempotency: old clients still
receive a fresh upload ID for a new accepted request.

The response, injected SkillHub metadata, saved files and queued manifest all
use the reserved version. Reservation locks are released before file IO, Git,
network work or scanning. Initial releases keep their requested version; an
occupied numeric version range advances the patch number. Arithmetic uses
integers without JavaScript floating-point rounding. Pre-release/build suffixes
retain the legacy numeric-triple comparison behavior, not full SemVer ordering.

The existing catalogue owner, first reservation owner and earliest legacy job
owner must match the writer. These checks bind release slots, not CatsCo human
identity or Bot ownership. Identity delegation still belongs to later integration.

## Workers and commit

Before Git writes, workers adopt/verify their exact slot. Old jobs are never
silently renumbered, because their stored files may already embed the original
version. If two old jobs already claim the same version, only the earliest job
can adopt it; the other fails with `skillhub.publication_version_conflict`.
An existing reservation or published version belonging to another upload also
fails. This does not automatically repair historical collisions.

The package transaction takes the same lock and validates the slot again. An
identical committed upload/checksum is idempotent; a different checksum is not
overwritten. Completion out of order does not move `skills.latest_version`
backwards. Worker replay detects an already committed upload before rebuilding;
it does not resign the package or revive a yanked version. New versions preserve
the current skill-level visibility scope and grants.

## Retention and rollout

Migration `013_publication_version_reservations` is required before new API and
Worker binaries start. Reservations do not expire or recycle automatically:
failed work may already have left an immutable Git tag. This can leave version
gaps, but must not permit a different release to overwrite that identity. No
candidate bytes, credentials or user-supplied files are stored in this table.

Upgrade **all public API and Worker writers** before relying on the new locking
contract. Do not intentionally run mixed old/new public writers: old binaries
cannot obey this lock. Existing queued jobs are accounted for and can be adopted
after upgrade; already colliding legacy jobs need operator review. Rolling back
application binaries leaves the additive table intact but loses allocation
guarantees; quiesce publishing first. No production deployment or data cleanup
is part of this PR.

P2-B2 must still bind exact candidate bytes, revalidate final derived packages
and publishing authority, reserve publication identity durably, fence stale
workers, and link committed package results atomically to publication tasks.
Neither task success nor end-to-end publication recovery is claimed here.
