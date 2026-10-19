# Publication commit permit transport

The service client and internal commit coordinator default off. A separately
default-off service adapter exposes plan/read/authorize, not user approval or an
application scheduler. A separately gated worker lane can execute existing durable
permits without issuing new ones. Migration 019 permits only delegated commits bound to retained proof;
ordinary account APIs and workers remain account-only.

createPublicationCommitPermitClient({enabled,issuer,audience,peerSecret})
defaults off. With explicit configuration it POSTs only to the fixed CatsCo
/api/skillhub/publications/internal/commit-permits/authorize HTTPS path. Native
TLS verifies certificates; no redirects, caller URLs, proxy environment, browser
session or upload-token fallback. The dedicated secret is server configuration.

authorize({schemaVersion:1,receipt,target}) snapshots the exact historical
receipt and ten release-target fields before I/O. The target includes candidate
and manifest hashes, publisher user/profile/namespace, Skill ID, reserved version
and upload ID, exact release timestamp and confirmation choice. This client
cannot record or alter the trusted human intent. CatsCo must already have one.

The response must echo the exact receipt/target with a bounded permit ID, local
integrity digest, authority epoch and UTC RFC3339Nano authorization timestamp.
The digest is opaque CatsCo integrity evidence, not a cross-language canonical
JSON hash or bearer. Timestamp text retains microseconds/nanoseconds; do not
round it through JS Date before storing or comparing recovery evidence.

The client caps replies at 4 KiB, headers at 8 KiB, transport duration at 6 seconds
and concurrent requests at 16, retaining slots until transport close. Every
response must be JSON and no-store; malformed/unknown responses, TLS/network
failure and 503 yield a sanitized unavailable error. Only exact authenticated
status/error pairs map to denied (403), cancelled (409) or conflict (409).
The client does not retry or consume a repair round.

## Recovery and cancellation

The permit is historical evidence for one immutable action. After a lost reply,
request the same facts: CatsCo returns the original ID and timestamp. Cancellation
before first issuance denies authorization. Later local cancellation or authority
loss does not erase a previously issued permit. This does **not** allow Cloud to
revive a cancelled task: the internal coordinator serializes permit recording
and commit start against Cloud cancellation, rechecks publisher identity and
uses the existing recoverable Git/package worker. It is not enabled in the
application. See [delegated commit coordination](publication-delegated-commit.md).

## Verification

TLS integration tests cover strict request/response scope, default-off config,
snapshot isolation, timestamps, status mapping, redirect/cert failures, malformed
and oversized bodies, abort/deadline handling and concurrency.

The required CI permit contract includes the reviewed CatsCo PR666 code
and runs its real HTTPS handler and PostgreSQL adapter against this actual Node
client. It commits a permit, drops the response, reopens the adapter/handler and
uses a fresh client; the original permit/time must survive. It also checks missing
intent, wrong target/credentials, cancellation-first denial and historical replay
after cancellation/disablement. Missing dependencies fail CI. Receipt and trusted
intent are test setup; that transport test is not live user approval or package
writing. A separate required dual-store contract exercises actual Cloud intake,
plan, permit and signed package publication through the real CatsCo PostgreSQL
handler. Source probing and trusted human intent remain explicit test setup;
neither contract is a live Runtime/UI publication E2E. The dual-store test now
also exercises the real CatsCo plan/status client and Cloud delegated scheduler,
pinning the reviewed PR667 merge `eb38e08e577a1eb45378cb36949a455d3e698419`.

