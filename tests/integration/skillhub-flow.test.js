import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { closePools, createStore } from "../../packages/database/store.js";
import { sha256 } from "../../packages/domain/index.js";
import {
  computePrivateSkillContentHash,
  publicVersionAsDownloadedPackage
} from "../../packages/private-skills/index.js";
import { downloadAndVerifyPackage, getPublicKeys } from "../../packages/sdk/index.js";
import { ensureRootKey } from "../../packages/signing/index.js";

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;

let server;
let catsCoUpstream;
let baseUrl;
let config;
let root;
let store;
let cookies = "";
const suffix = Date.now().toString(36);

before(async () => {
  if (!databaseUrl) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "catsco-skillhub-pg-test-"));
  catsCoUpstream = http.createServer((req, res) => {
    if (req.headers.authorization === "Bearer concurrent-cats-token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        uid: `profile-${suffix}`,
        username: `concurrent-${suffix}`,
        display_name: `Concurrent ${suffix}`
      }));
      return;
    }
    if (req.headers.authorization !== "ApiKey bot-key-a") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: "42001" }));
  });
  await new Promise((resolve) => catsCoUpstream.listen(0, "127.0.0.1", resolve));
  const catsCoAddress = catsCoUpstream.address();
  config = loadConfig({
    root,
    storageRoot: path.join(root, "storage"),
    logsRoot: path.join(root, "logs"),
    sharedRoot: path.join(root, "shared"),
    databaseUrl,
    sessionSecret: "test-session-secret-that-is-long-enough-for-tests",
    catsCoBaseUrl: `http://127.0.0.1:${catsCoAddress.port}`,
    allowAutoKeygen: true,
    nodeEnv: "test"
  });
  await ensureRootKey(config);
  store = createStore(config);
  server = createApiServer(config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.publicBaseUrl = baseUrl;
  config.packageBaseUrl = `${baseUrl}/packages`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (catsCoUpstream) await new Promise((resolve) => catsCoUpstream.close(resolve));
  if (root) await fs.rm(root, { recursive: true, force: true });
  await closePools();
});

test("PostgreSQL-backed current share flow works", { skip: !databaseUrl }, async () => {
  await register(`developer-${suffix}@example.com`, "developer-pass-123");
  await login(`developer-${suffix}@example.com`, "developer-pass-123");

  const reservationsBeforeReject = await store.query("SELECT count(*)::int AS count FROM publication_version_reservations");
  const rejected = await fetch(`${baseUrl}/api/skills/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify({
      manifest: { displayName: `Rejected Skill ${suffix}` },
      source: { type: "files", files: [{ path: "SKILL.md", content: "# Missing required frontmatter\n" }] }
    })
  });
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 422);
  assert.equal(rejectedBody.error.code, "skillhub.publish_validation_failed");
  assert.equal(rejectedBody.error.validation.outcome, "rejected");
  assert.ok(rejectedBody.error.validation.issues.some(issue => issue.code === "frontmatter.missing"));
  const reservationsAfterReject = await store.query("SELECT count(*)::int AS count FROM publication_version_reservations");
  assert.equal(reservationsAfterReject.rows[0].count, reservationsBeforeReject.rows[0].count);

  const shared = await postJson("/api/skills/share", {
    source: {
      type: "files",
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: contract-review-assistant-${suffix}\ndescription: Reviews contract clauses and highlights risks requiring human confirmation.\n---\n# Contract Review Assistant ${suffix}\n\nReviews contract clauses and highlights risks requiring human confirmation.\n`
        },
        {
          path: "README.md",
          content: "A test skill that only analyzes contract text explicitly supplied by the user.\n"
        }
      ]
    },
    manifest: {
      displayName: `Contract Review Assistant ${suffix}`,
      version: `1.0.${Number.parseInt(suffix.slice(-2), 36)}`,
      description: "Reviews contract clauses, payment terms, liability and legal risks.",
      author: { name: "CatsCo Test" },
      license: "MIT",
      permissions: { filesystem: "user_selected", network: "none", shell: "none", secrets: "none" }
    },
    confirmVersionPublish: true,
    runJobsInline: true
  });
  assert.ok(shared.upload.fileCount >= 2);

  const search = await getJson(`/api/skills?q=${encodeURIComponent(suffix)}`);
  assert.ok(search.skills.some((skill) => skill.displayName.includes(suffix)));

  const skill = search.skills.find((item) => item.displayName.includes(suffix));
  const keys = await getPublicKeys(baseUrl);
  const packageObject = await downloadAndVerifyPackage({
    packageUrl: skill.packageUrl,
    checksumSha256: skill.checksumSha256,
    publicKeys: keys.keys
  });
  assert.equal(packageObject.payload.manifest.displayName, `Contract Review Assistant ${suffix}`);

  // The package URL is also a public-facing download surface. Verify that it
  // is backed by the same ACL as the catalogue before changing visibility.
  const publicPackage = await fetch(skill.packageUrl);
  assert.equal(publicPackage.status, 200);
  assert.equal(publicPackage.headers.get("cache-control"), "private, no-store");
  const ownerPackage = await fetch(skill.packageUrl, { headers: { Cookie: cookies } });
  assert.equal(ownerPackage.status, 200);

  const visibilityBefore = await getJson(`/api/skills/${encodeURIComponent(skill.skillId)}/visibility`);
  const privateUpdate = await patchJson(`/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    visibilityScope: "private",
    expectedRevision: visibilityBefore.visibility.visibilityRevision
  });
  assert.equal(privateUpdate.visibility.visibilityScope, "private");
  const hiddenPackage = await fetch(skill.packageUrl);
  assert.equal(hiddenPackage.status, 404);
  const ownerPackageAfterPrivate = await fetch(skill.packageUrl, { headers: { Cookie: cookies } });
  assert.equal(ownerPackageAfterPrivate.status, 200);

  // Deleting the administrator who wrote a grant must not delete or block the
  // grant itself; only its optional audit pointer is cleared.
  const grantWriterId = `visibility-grant-writer-${suffix}`;
  await store.query(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'disabled-test-password', 'Visibility grant writer')",
    [grantWriterId, `${grantWriterId}@example.invalid`]
  );
  const sharedUpdate = await store.updateSkillVisibility({
    skillId: skill.skillId,
    actorUserId: grantWriterId,
    isAdmin: true,
    visibilityScope: "shared",
    sharedUserUids: [`shared-${suffix}`],
    expectedRevision: privateUpdate.visibility.visibilityRevision
  });
  await store.query("DELETE FROM users WHERE id = $1", [grantWriterId]);
  const grant = await store.query(
    "SELECT catsco_uid, granted_by_user_id FROM skill_visibility_grants WHERE skill_id = $1",
    [skill.skillId]
  );
  assert.deepEqual(grant.rows, [{ catsco_uid: `shared-${suffix}`, granted_by_user_id: null }]);

  // Catalogue discovery and version reads must use the same ACL.  A shared
  // skill is visible to its owner and the granted CatsCo UID, but not to an
  // unrelated UID or an anonymous viewer.  Keep this at the store boundary
  // so the regression remains covered even when the HTTP proxy is unavailable.
  const owner = await store.getUserByEmail(`developer-${suffix}@example.com`);
  const ownerViewer = { viewerUserId: owner.id, viewerCatsCoUid: null, includeAll: false };
  const granteeViewer = { viewerUserId: null, viewerCatsCoUid: `shared-${suffix}`, includeAll: false };
  const foreignViewer = { viewerUserId: null, viewerCatsCoUid: `foreign-${suffix}`, includeAll: false };
  const visibleToOwner = await store.listCatalogueVersions(ownerViewer);
  const visibleToGrantee = await store.listCatalogueVersions(granteeViewer);
  const visibleToForeign = await store.listCatalogueVersions(foreignViewer);
  assert.ok(visibleToOwner.some((item) => item.skillId === skill.skillId));
  assert.ok(visibleToGrantee.some((item) => item.skillId === skill.skillId));
  assert.equal(visibleToForeign.some((item) => item.skillId === skill.skillId), false);
  assert.equal((await store.findPublishedVersion(skill.skillId, skill.latestVersion, foreignViewer)), null);
  assert.ok(await store.findPublishedVersion(skill.skillId, skill.latestVersion, granteeViewer));

  // Publishing a newer release must keep the Skill-level visibility policy;
  // a version update must not silently make a shared Skill public.
  const nextVersion = `1.0.${Number(String(skill.latestVersion).split(".").at(-1)) + 1}`;
  await postJson("/api/skills/share", {
    source: {
      type: "files",
      files: [{
        path: "SKILL.md",
        content: `---\nname: contract-review-assistant-${suffix}\ndescription: Reviews contract clauses and highlights risks requiring human confirmation.\n---\n# Contract Review Assistant ${suffix} v${nextVersion}\n\nUpdated test release.\n`
      }]
    },
    manifest: {
      displayName: `Contract Review Assistant ${suffix}`,
      version: nextVersion,
      description: "Reviews contract clauses, payment terms, liability and legal risks.",
      author: { name: "CatsCo Test" },
      license: "MIT",
      permissions: { filesystem: "user_selected", network: "none", shell: "none", secrets: "none" }
    },
    confirmVersionPublish: true,
    runJobsInline: true
  });
  assert.equal((await store.findPublishedVersion(skill.skillId, nextVersion, foreignViewer)), null);
  assert.ok(await store.findPublishedVersion(skill.skillId, nextVersion, granteeViewer));

  assert.equal((await fetch(skill.packageUrl)).status, 404);
  assert.equal((await fetch(skill.packageUrl, { headers: { Cookie: cookies } })).status, 200);

  await store.updateSkillVisibility({
    skillId: skill.skillId,
    actorUserId: (await store.getUserByEmail(`developer-${suffix}@example.com`)).id,
    visibilityScope: "public",
    expectedRevision: sharedUpdate.visibilityRevision
  });

  const published = await store.findPublishedVersion(skill.skillId, skill.latestVersion);
  assert.ok(published);
  await store.yankPackageVersion(published.id);
  const newerPublished = await store.findPublishedVersion(skill.skillId, nextVersion);
  assert.ok(newerPublished);
  await store.yankPackageVersion(newerPublished.id);
  const hiddenAfterYank = await getJson(`/api/skills?q=${encodeURIComponent(suffix)}`);
  assert.equal(hiddenAfterYank.skills.some((item) => item.skillId === skill.skillId), false);
  const recoverable = await store.findRecoverablePublishedVersion(skill.skillId, skill.latestVersion);
  assert.ok(recoverable);
  const restored = await publicVersionAsDownloadedPackage(recoverable, config);
  assert.deepEqual(restored.reference, { skillId: skill.skillId, version: skill.latestVersion });

  const botPath = `/api/bot/skill-packages/${encodeURIComponent(skill.skillId)}/versions/${encodeURIComponent(skill.latestVersion)}`;
  const botRecovered = await botRequest("GET", botPath);
  assert.equal(botRecovered.status, 200);
  assert.deepEqual(botRecovered.data.reference, { skillId: skill.skillId, version: skill.latestVersion });

  const publicVersion = await fetch(
    `${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/versions/${encodeURIComponent(skill.latestVersion)}`
  );
  assert.equal(publicVersion.status, 404);

  const forkBytes = Buffer.from(`# Private fork of ${skill.skillId}\n`);
  const forkFiles = [{
    path: "SKILL.md",
    size: forkBytes.length,
    sha256: sha256(forkBytes),
    contentBase64: forkBytes.toString("base64")
  }];
  const forked = await botRequest("PUT", "/api/bot/private-skill-packages", {
    localSkillId: `fork-${suffix}`,
    name: `fork-${suffix}`,
    contentHash: computePrivateSkillContentHash(forkFiles),
    origin: { skillId: skill.skillId, version: skill.latestVersion },
    files: forkFiles
  });
  assert.equal(forked.status, 201);

  const legacyBytes = Buffer.from(`# Local backup from a retired Registry ${suffix}\n`);
  const legacyFiles = [{
    path: "SKILL.md",
    size: legacyBytes.length,
    sha256: sha256(legacyBytes),
    contentBase64: legacyBytes.toString("base64")
  }];
  const historicalOrigin = {
    skillId: `retired-author/retired-skill-${suffix}`,
    version: "1.2.3"
  };
  const historicalBackup = await botRequest("PUT", "/api/bot/private-skill-packages", {
    localSkillId: `historical-${suffix}`,
    name: `historical-${suffix}`,
    contentHash: computePrivateSkillContentHash(legacyFiles),
    origin: historicalOrigin,
    files: legacyFiles
  });
  assert.equal(historicalBackup.status, 201);
  assert.deepEqual(historicalBackup.data.origin, historicalOrigin);

  const foreignPrivateOrigin = await botRequest("PUT", "/api/bot/private-skill-packages", {
    localSkillId: `foreign-private-${suffix}`,
    name: `foreign-private-${suffix}`,
    contentHash: computePrivateSkillContentHash(legacyFiles),
    origin: {
      skillId: `priv_${"a".repeat(40)}`,
      version: `v_${"b".repeat(48)}`
    },
    files: legacyFiles
  });
  assert.equal(foreignPrivateOrigin.status, 400);
  assert.equal(foreignPrivateOrigin.data.error.code, "PRIVATE_SKILL_ORIGIN_NOT_FOUND");

  const malformedPrivateOrigin = await botRequest("PUT", "/api/bot/private-skill-packages", {
    localSkillId: `malformed-private-${suffix}`,
    name: `malformed-private-${suffix}`,
    contentHash: computePrivateSkillContentHash(legacyFiles),
    origin: {
      skillId: "PRIVATE/legacy-reference",
      version: "legacy-version"
    },
    files: legacyFiles
  });
  assert.equal(malformedPrivateOrigin.status, 400);
  assert.equal(malformedPrivateOrigin.data.error.code, "PRIVATE_SKILL_ORIGIN_NOT_FOUND");

  await store.deletePackageVersion(published.id);
  const retainedAfterDelete = await store.findRecoverablePublishedVersion(skill.skillId, skill.latestVersion);
  assert.ok(retainedAfterDelete);
  assert.equal(retainedAfterDelete.status, "yanked");
  const stillRecoverableByBot = await botRequest("GET", botPath);
  assert.equal(stillRecoverableByBot.status, 200);
});

test("whole-Skill moderation hides all published versions and records the batch", { skip: !databaseUrl }, async () => {
  const publisherEmail = `moderation-publisher-${suffix}@example.com`;
  const adminEmail = `moderation-admin-${suffix}@example.com`;
  const password = "moderation-test-pass-123";
  await register(publisherEmail, password);
  await login(publisherEmail, password);

  async function publish(name, version) {
    await postJson("/api/skills/share", {
      source: { type: "files", files: [{
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: Formats sample text for a moderation test.\n---\n# Test Skill\n\nFormats sample text for release ${version}.\n`
      }] },
      manifest: { name, displayName: name, version, license: "MIT" },
      confirmVersionPublish: true,
      runJobsInline: true
    });
    const { skills } = await getJson(`/api/skills?q=${name}`);
    const skill = skills.find((item) => item.name === name);
    assert.ok(skill, `expected published Skill ${name}`);
    return skill;
  }

  const first = await publish(`moderation-first-${suffix}`, "1.0.0");
  await publish(first.name, "1.0.1");
  const second = await publish(`moderation-second-${suffix}`, "1.0.0");
  const control = await publish(`moderation-control-${suffix}`, "1.0.0");
  const firstPath = `/api/skills/${encodeURIComponent(first.skillId)}`;
  const cataloguePath = `/api/catalogue/skills?q=${first.name}`;
  const yankPath = "/api/admin/skills/yank";
  const sendBatch = (skillIds) => fetch(`${baseUrl}${yankPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify({ skillIds, reason: "moderation regression" })
  });
  assert.equal((await sendBatch([first.skillId])).status, 403);

  await register(adminEmail, password);
  const admin = await login(adminEmail, password);
  await store.grantRole({ userId: admin.user.id, role: "admin", grantedBy: admin.user.id });
  const { skillVersions } = await getJson(`/api/admin/skills/${encodeURIComponent(first.skillId)}/versions`);
  const newestId = skillVersions.find((item) => item.latestVersion === "1.0.1").packageVersionId;
  const oldestId = skillVersions.find((item) => item.latestVersion === "1.0.0").packageVersionId;
  await postJson(`/api/admin/skill-versions/${newestId}/yank`, {});
  assert.equal((await getJson(firstPath)).skill.latestVersion, "1.0.0");
  assert.ok((await getJson(cataloguePath)).skills.some((item) => item.skillId === first.skillId));

  assert.equal((await sendBatch([])).status, 400);
  assert.equal((await sendBatch([first.skillId, `unknown/not-found-${suffix}`])).status, 404);
  assert.equal((await fetch(`${baseUrl}${firstPath}/versions/1.0.0/download`)).status, 200);
  const batch = await sendBatch([second.skillId, first.skillId, second.skillId]);
  assert.equal(batch.status, 200);
  assert.deepEqual((await batch.json()).skills, [
    { skillId: second.skillId, hiddenVersions: 1 }, { skillId: first.skillId, hiddenVersions: 1 }
  ]);
  assert.equal((await fetch(`${baseUrl}${firstPath}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${firstPath}/versions/1.0.0/download`)).status, 404);
  assert.equal((await fetch(first.packageUrl)).status, 404);
  assert.deepEqual((await getJson(`${firstPath}/versions`)).versions, []);
  assert.ok(!(await getJson(`/api/skills?q=${first.name}`)).skills.some((item) => item.skillId === first.skillId));
  assert.ok(!(await getJson(cataloguePath)).skills.some((item) => item.skillId === first.skillId));
  assert.equal((await fetch(`${baseUrl}/api/skills/${encodeURIComponent(second.skillId)}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/skills/${encodeURIComponent(control.skillId)}`)).status, 200);

  assert.deepEqual((await postJson(yankPath, { skillIds: [first.skillId] })).skills, [
    { skillId: first.skillId, hiddenVersions: 0 }
  ]);
  const { skills: hiddenSkills } = await getJson(`/api/admin/skills?q=${first.name}&status=yanked`);
  assert.equal(hiddenSkills[0].latestVersion, null);
  assert.equal(hiddenSkills[0].versionCount, 2);
  assert.equal(hiddenSkills[0].publishedVersionCount, 0);
  const { auditLogs } = await getJson(`/api/admin/audit-logs?action=skill.hidden_admin&actorUserId=${admin.user.id}`);
  assert.deepEqual(auditLogs.map((entry) => entry.resourceId).sort(), [first.skillId, second.skillId].sort());
  assert.ok(auditLogs.every((entry) => entry.metadata.versionCount === 1 && entry.metadata.reason === "moderation regression"));

  await postJson(`/api/admin/skill-versions/${oldestId}/restore`, {});
  assert.equal((await getJson(firstPath)).skill.latestVersion, "1.0.0");
  assert.equal((await fetch(`${baseUrl}${firstPath}/versions/1.0.1`)).status, 404);
});

test("PostgreSQL-backed concurrent first profile sync creates one identity", { skip: !databaseUrl }, async () => {
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/auth/catsco-profile-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "concurrent-cats-token" })
    }),
    fetch(`${baseUrl}/api/auth/catsco-profile-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "concurrent-cats-token" })
    })
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);

  const [first, second] = await Promise.all(responses.map((response) => response.json()));
  assert.equal(first.developerProfile.userId, second.developerProfile.userId);

  const profile = await store.getDeveloperProfileByCatsCoUid(`profile-${suffix}`);
  assert.ok(profile);
  assert.equal(profile.userId, first.developerProfile.userId);
});

async function register(email, password) {
  return postJson("/api/auth/register", { email, password, displayName: email.split("@")[0] });
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  cookies = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function postJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: cookies ? { Cookie: cookies } : {}
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function patchJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function botRequest(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: "ApiKey bot-key-a",
      "X-CatsCo-Bot-Id": "42001",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}
