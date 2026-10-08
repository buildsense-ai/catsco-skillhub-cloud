import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { loadConfig } from "../../packages/config/index.js";
import { closePools, createStore } from "../../packages/database/store.js";
import { parsePresentationContent } from "../../packages/presentations/index.js";
import { createPresentationStore } from "../../packages/presentations/store.js";

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;
const pg = { skip: !databaseUrl };
const userIds = [];
const versionIds = [];
let store;

before(() => {
  if (!databaseUrl) return;
  store = createStore(loadConfig({ databaseUrl, nodeEnv: "test" }));
});

after(async () => {
  if (!store) return;
  try {
    await store.tx(async (client) => {
      // Cleanup only this suite's randomly named fixtures, even on assertion failure.
      await client.query("DELETE FROM skill_presentation_revisions WHERE package_version_id = ANY($1::text[])", [versionIds]);
      await client.query("DELETE FROM skill_presentations WHERE package_version_id = ANY($1::text[])", [versionIds]);
      await client.query("DELETE FROM audit_logs WHERE resource_type = 'skill_presentation' AND resource_id = ANY($1::text[])", [versionIds]);
      await client.query("DELETE FROM skill_versions WHERE id = ANY($1::text[])", [versionIds]);
      await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
    });
  } finally {
    await closePools();
  }
});

function content(summary = "Read documents", primaryCategory = "documents") {
  return { schemaVersion: 1, summary, primaryCategory, details: "Private draft details", example: { kind: "document", input: "A document", output: "An illustrative summary" } };
}

async function person(role = "user") {
  const id = `presentation-user-${randomUUID()}`;
  await store.query("INSERT INTO users (id, email, password_hash, display_name) VALUES ($1,$2,'disabled-test-password','Presentation test user')", [id, `${id}@example.invalid`]);
  userIds.push(id);
  return { userId: id, role, roles: [role] };
}

async function fixture({ owner, skillId, version = "1.0.0" } = {}) {
  owner ||= await person();
  const id = `presentation-version-${randomUUID()}`;
  skillId ||= `presentation-${randomUUID()}/same-name`;
  const manifest = { name: "same-name", displayName: "Same visible name", description: "Original immutable package description", categories: ["other"], tags: [], runtime: {}, author: { name: "untrusted-author-field" } };
  await store.query(`INSERT INTO skill_versions
    (id, skill_id, skill_name, display_name, owner_user_id, version, status,
      package_path, package_file, package_url, package_size, checksum_sha256, payload_sha256,
      content_hash, signature, manifest, upload_id, published_at)
    VALUES ($1,$2,'same-name','Same visible name',$3,$4,'published',
      'unused-test-package','test.skillpkg','https://example.invalid/test.skillpkg',42,$5,$6,$7,$8,$9,$10,now())`,
  [id, skillId, owner.userId, version, "a".repeat(64), "b".repeat(64), "c".repeat(64),
    JSON.stringify({ keyId: "test-key", signature: "test-signature" }), JSON.stringify(manifest), `upload-${id}`]);
  versionIds.push(id);
  return { id, owner, target: { skillId, version } };
}

function write(item, expectedRevision, action = "draft", draft = content(), actor = item.owner, reason) {
  return store.writeSkillPresentation({ ...item.target, expectedRevision,
    ...(action === "draft" ? { content: draft } : {}), ...(reason === undefined ? {} : { reason }) }, actor, action, "192.0.2.10");
}

async function snapshot(item) {
  return (await store.query("SELECT * FROM skill_versions WHERE id = $1", [item.id])).rows[0];
}

test("PostgreSQL presentation drafts remain private and editing never changes package identity", pg, async () => {
  const item = await fixture();
  const packageBefore = await snapshot(item);
  assert.equal(await store.getSkillPresentation(item.target), null);
  const empty = await store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner });
  assert.equal(empty.revision, 0);
  assert.equal(empty.draft, null);

  const first = await write(item, 0);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.draft, parsePresentationContent(content()));
  assert.equal(first.published, null);
  assert.equal(await store.getSkillPresentation(item.target), null);

  const published = await write(item, 1, "publish");
  assert.equal(published.revision, 2);
  assert.equal(published.published.revision, 2);
  assert.equal(published.published.sourceContentHash, packageBefore.content_hash);
  assert.equal(published.published.exampleDisclosure, "illustrative_not_tested");
  await write(item, 2, "draft", content("Unpublished next draft", "data"));
  const publicRead = await store.getSkillPresentation(item.target);
  assert.equal(publicRead.content.summary, "Read documents");
  assert.equal(publicRead.revision, 2);
  assert.equal("draft" in publicRead, false);
  assert.equal("owner_user_id" in publicRead, false);

  const privateRead = await store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner });
  assert.equal(privateRead.revision, 3);
  assert.equal(privateRead.draft.summary, "Unpublished next draft");
  assert.equal(privateRead.published.content.summary, "Read documents");
  await write(item, 3, "unpublish");
  assert.equal(await store.getSkillPresentation(item.target), null);
  const retainedDraft = await store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner });
  assert.equal(retainedDraft.revision, 4);
  assert.equal(retainedDraft.draft.summary, "Unpublished next draft");
  assert.deepEqual(await snapshot(item), packageBefore, "all package columns, hashes and signatures remain untouched");

  const audit = (await store.query("SELECT action, metadata, ip FROM audit_logs WHERE resource_id = $1 ORDER BY (metadata->>'revision')::int", [item.id])).rows;
  assert.equal(audit.length, 4);
  assert.deepEqual(audit.map((row) => row.metadata.revision), [1, 2, 3, 4]);
  for (const row of audit) {
    assert.match(row.metadata.contentHash, /^[a-f0-9]{64}$/);
    assert.notEqual(row.ip, "192.0.2.10");
    assert.equal(JSON.stringify(row).includes("Private draft details"), false);
  }
});

test("PostgreSQL presentation writes require human publisher identity or admin with a reason", pg, async () => {
  const item = await fixture();
  const stranger = await person();
  const admin = await person("admin");
  await assert.rejects(write(item, 0, "draft", content(), stranger), { status: 404 });
  await assert.rejects(store.getSkillPresentation({ ...item.target, draft: true, actor: stranger }), { status: 404 });
  await assert.rejects(write(item, 0, "draft", content(), { role: "agent", userId: item.owner.userId, roles: ["agent"] }), { status: 401 });
  await assert.rejects(write(item, 0, "draft", content(), null), { status: 401 });
  await assert.rejects(write(item, 0, "draft", content(), admin), { code: "presentation.invalid" });
  const saved = await write(item, 0, "draft", content("Administrator clarification"), admin, "Correct misleading instructions");
  assert.equal(saved.revision, 1);
  assert.equal(saved.draftOrigin, "admin");
  assert.equal((await store.getSkillPresentation({ ...item.target, draft: true, actor: admin })).draft.summary, "Administrator clarification");
  const rows = (await store.query("SELECT actor_user_id, reason FROM skill_presentation_revisions WHERE package_version_id = $1", [item.id])).rows;
  assert.deepEqual(rows, [{ actor_user_id: admin.userId, reason: "Correct misleading instructions" }]);
  const ownerConfirmation = await write(item, 1, "publish");
  assert.equal(ownerConfirmation.published.origin, "admin", "confirmation actor does not rewrite content provenance");
  await write(item, 2, "draft", content("Author's replacement"));
  const adminConfirmation = await write(item, 3, "publish", undefined, admin, "Confirm author correction");
  assert.equal(adminConfirmation.published.origin, "author");
});

test("PostgreSQL presentation identity separates same-name publishers and exact package versions", pg, async () => {
  const first = await fixture();
  const differentPublisher = await fixture();
  const laterVersion = await fixture({ owner: first.owner, skillId: first.target.skillId, version: "1.0.1" });
  await write(first, 0);
  await write(first, 1, "publish");
  assert.equal(await store.getSkillPresentation(differentPublisher.target), null);
  assert.equal(await store.getSkillPresentation(laterVersion.target), null);
  await assert.rejects(write(first, 2, "draft", content(), differentPublisher.owner), { status: 404 });
  await assert.rejects(store.getSkillPresentation({ ...first.target, version: "9.9.9" }), { status: 404 });
});

test("PostgreSQL concurrent first drafts serialize with one successful compare-and-swap", pg, async () => {
  const item = await fixture();
  const results = await Promise.allSettled([write(item, 0, "draft", content("First contender")), write(item, 0, "draft", content("Second contender"))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "presentation.revision_conflict");
  const current = await store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner });
  assert.equal(current.revision, 1);
  const history = (await store.query("SELECT * FROM skill_presentation_revisions WHERE package_version_id = $1", [item.id])).rows;
  assert.equal(history.length, 1);
  assert.equal((await store.query("SELECT * FROM audit_logs WHERE resource_id = $1", [item.id])).rowCount, 1);
});

test("PostgreSQL publishing races with draft saves without publishing unreviewed content", pg, async () => {
  const item = await fixture();
  await write(item, 0, "draft", content("Reviewed draft"));
  const [publication, saving] = await Promise.allSettled([write(item, 1, "publish"), write(item, 1, "draft", content("Not reviewed yet"))]);
  assert.equal([publication, saving].filter((result) => result.status === "fulfilled").length, 1);
  const rejected = [publication, saving].find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "presentation.revision_conflict");
  const current = await store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner });
  assert.equal(current.revision, 2);
  if (publication.status === "fulfilled") {
    assert.equal(current.published.content.summary, "Reviewed draft");
    assert.equal(current.draft.summary, "Reviewed draft");
  } else {
    assert.equal(current.published, null);
    assert.equal(current.draft.summary, "Not reviewed yet");
  }
  await assert.rejects(write(item, 1, "publish"), { code: "presentation.revision_conflict" });
});

test("PostgreSQL audit failure rolls back presentation head and immutable history atomically", pg, async () => {
  const item = await fixture();
  const failing = createPresentationStore({
    query: store.query,
    tx: (fn) => store.tx((client) => fn({
      query: (sql, parameters) => {
        if (/INSERT INTO audit_logs/.test(sql)) throw new Error("Injected audit failure");
        return client.query(sql, parameters);
      }
    }))
  });
  await assert.rejects(failing.writeSkillPresentation({ ...item.target, expectedRevision: 0, content: content() }, item.owner, "draft"), /Injected audit failure/);
  assert.equal((await store.query("SELECT * FROM skill_presentations WHERE package_version_id = $1", [item.id])).rowCount, 0);
  assert.equal((await store.query("SELECT * FROM skill_presentation_revisions WHERE package_version_id = $1", [item.id])).rowCount, 0);
  await write(item, 0);
  await assert.rejects(failing.writeSkillPresentation({ ...item.target, expectedRevision: 1 }, item.owner, "publish"), /Injected audit failure/);
  const current = await store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner });
  assert.equal(current.revision, 1);
  assert.equal(current.published, null);
  assert.equal((await store.query("SELECT * FROM skill_presentation_revisions WHERE package_version_id = $1", [item.id])).rowCount, 1);
  assert.equal((await store.query("SELECT * FROM audit_logs WHERE resource_id = $1", [item.id])).rowCount, 1);
});

test("PostgreSQL yanked exact versions hide public and draft presentation reads and reject writes", pg, async () => {
  const item = await fixture();
  await write(item, 0);
  await write(item, 1, "publish");
  await store.query("UPDATE skill_versions SET status = 'yanked', yanked_at = now() WHERE id = $1", [item.id]);
  await assert.rejects(store.getSkillPresentation(item.target), { status: 404 });
  await assert.rejects(store.getSkillPresentation({ ...item.target, draft: true, actor: item.owner }), { status: 404 });
  for (const action of ["draft", "publish", "unpublish"]) {
    await assert.rejects(write(item, 2, action), { status: 404 });
  }
  assert.equal((await store.query("SELECT * FROM skill_presentation_revisions WHERE package_version_id = $1", [item.id])).rowCount, 2);
});

test("PostgreSQL catalogue exposes published summaries only, with no draft bodies or yanked rows", pg, async () => {
  const live = await fixture();
  const draftOnly = await fixture();
  const yanked = await fixture();
  await write(live, 0, "draft", content("Live catalogue summary", "research"));
  await write(live, 1, "publish");
  await write(live, 2, "draft", content("Secret next summary", "media"));
  await write(draftOnly, 0, "draft", content("Never public"));
  await write(yanked, 0);
  await write(yanked, 1, "publish");
  await store.query("UPDATE skill_versions SET yanked_at = now() WHERE id = $1", [yanked.id]);
  const rows = await store.listCatalogueVersions();
  const liveRow = rows.find((row) => row.skillId === live.target.skillId);
  assert.deepEqual(liveRow.presentationSummary, { revision: 2, summary: "Live catalogue summary", primaryCategory: "research" });
  assert.equal(JSON.stringify(liveRow).includes("Secret next summary"), false);
  assert.equal(JSON.stringify(liveRow).includes("Private draft details"), false);
  assert.equal(rows.find((row) => row.skillId === draftOnly.target.skillId).presentationSummary, undefined);
  assert.equal(rows.some((row) => row.skillId === yanked.target.skillId), false);
  await write(live, 3, "unpublish");
  const unpublished = (await store.listCatalogueVersions()).find((row) => row.skillId === live.target.skillId);
  assert.equal(unpublished.presentationSummary, undefined);
});

test("PostgreSQL presentation schema rejects incomplete public state and preserves account deletion semantics", pg, async () => {
  const item = await fixture();
  const body = JSON.stringify(parsePresentationContent(content()));
  await assert.rejects(store.query(`INSERT INTO skill_presentations
    (package_version_id, revision, draft_content, draft_origin, published_content, published_origin, published_revision, published_at)
    VALUES ($1,1,$2,'author',$2,'author',NULL,now())`, [item.id, body]), { code: "23514" });

  const admin = await person("admin");
  await write(item, 0, "draft", content(), admin, "Clarify old documentation");
  await write(item, 1, "publish");
  await store.query("DELETE FROM users WHERE id = $1", [admin.userId]);
  assert.equal((await store.getSkillPresentation(item.target)).origin, "admin");
  assert.equal((await store.query("SELECT actor_user_id FROM skill_presentation_revisions WHERE package_version_id = $1 AND revision = 1", [item.id])).rows[0].actor_user_id, admin.userId);

  await store.query("DELETE FROM users WHERE id = $1", [item.owner.userId]);
  assert.equal((await store.query("SELECT * FROM skill_versions WHERE id = $1", [item.id])).rowCount, 0);
  assert.equal((await store.query("SELECT * FROM skill_presentations WHERE package_version_id = $1", [item.id])).rowCount, 0);
  assert.equal((await store.query("SELECT * FROM skill_presentation_revisions WHERE package_version_id = $1", [item.id])).rowCount, 0);
  assert.equal((await store.query("SELECT * FROM audit_logs WHERE resource_id = $1", [item.id])).rowCount, 2);
});
