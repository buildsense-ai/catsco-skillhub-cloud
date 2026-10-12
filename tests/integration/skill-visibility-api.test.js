import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { createSessionToken, hashSessionToken } from "../../packages/auth/index.js";
import { ValidationError } from "../../packages/domain/index.js";

const skill = {
  id: "skill_visibility_test",
  skillId: "demo/visibility",
  skillName: "visibility",
  displayName: "Visibility Test",
  version: "1.0.0",
  status: "published",
  publishedAt: "2026-10-09T00:00:00.000Z",
  ownerUserId: "owner",
  manifest: { categories: ["documents"], description: "test" }
};

let server;
let catsServer;
let baseUrl;
let ownerCookie;
let granteeCookie;
let foreignCookie;
let adminCookie;
let calls;
let visibility;
let auditQueries;

before(async () => {
  catsServer = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer cats-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/me") {
      res.end(JSON.stringify({ uid: 42001, username: "owner", display_name: "Owner", account_type: "human" }));
      return;
    }
    const uid = new URL(req.url, "http://cats.test").searchParams.get("q");
    if (req.url === `/api/users/search?q=${uid}&mode=uid`) {
      const user = uid === "42002"
        ? { id: 42002, username: "grantee", display_name: "Grantee", account_type: "human" }
        : null;
      res.end(JSON.stringify({ users: user ? [user] : [] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => catsServer.listen(0, "127.0.0.1", resolve));
  const catsBaseUrl = `http://127.0.0.1:${catsServer.address().port}`;
  const config = loadConfig({ nodeEnv: "test", sessionSecret: "visibility-test-session-secret", catsCoBaseUrl: catsBaseUrl });
  const ownerToken = createSessionToken();
  const granteeToken = createSessionToken();
  const foreignToken = createSessionToken();
  const adminToken = createSessionToken();
  ownerCookie = `${config.session.cookieName}=${ownerToken}`;
  granteeCookie = `${config.session.cookieName}=${granteeToken}`;
  foreignCookie = `${config.session.cookieName}=${foreignToken}`;
  adminCookie = `${config.session.cookieName}=${adminToken}`;
  const sessions = new Map([
    [hashSessionToken(ownerToken, config.session.secret), "owner"],
    [hashSessionToken(granteeToken, config.session.secret), "grantee"],
    [hashSessionToken(foreignToken, config.session.secret), "foreign"],
    [hashSessionToken(adminToken, config.session.secret), "admin"]
  ]);
  calls = [];
  auditQueries = [];
  visibility = {
    skillId: skill.skillId,
    ownerUserId: "owner",
    visibilityScope: "public",
    visibilityRevision: 1,
    visibilityUpdatedAt: "2026-10-09T00:00:00.000Z",
    sharedUserUids: []
  };
  const canSee = (viewer = {}) => visibility.visibilityScope === "public"
    || viewer.viewerUserId === visibility.ownerUserId
    || (visibility.visibilityScope === "shared" && viewer.viewerCatsCoUid === "42002");
  const store = {
    getSessionByTokenHash: async (hash) => sessions.has(hash) ? { userId: sessions.get(hash) } : null,
    getUserById: async (id) => ({ id, email: `${id}@example.com`, displayName: id }),
    getRoles: async (id) => id === "admin" ? ["admin"] : ["user"],
    getDeveloperProfile: async (id) => id === "owner" ? { catsCoUid: "42001" }
      : id === "grantee" ? { catsCoUid: "42002" } : { catsCoUid: "42003" },
    listPublishedVersions: async (viewer) => { calls.push(["list", viewer]); return canSee(viewer) ? [skill] : []; },
    listPublishedVersionsForSkill: async (_skillId, viewer) => { calls.push(["detail", viewer]); return canSee(viewer) ? [skill] : []; },
    findPublishedVersion: async (_skillId, _version, viewer) => { calls.push(["version", viewer]); return canSee(viewer) ? skill : null; },
    getSkillVisibility: async () => ({ ...visibility, sharedUserUids: [...visibility.sharedUserUids] }),
    updateSkillVisibility: async (input) => {
      calls.push(["update", input]);
      if (input.expectedRevision !== visibility.visibilityRevision) {
        throw new ValidationError("visibility revision conflict", "skill.visibility_conflict", 409);
      }
      if (!input.isAdmin && input.actorUserId !== visibility.ownerUserId) {
        throw new ValidationError("visibility owner required", "skill.visibility_forbidden", 403);
      }
      visibility = {
        ...visibility,
        visibilityScope: input.visibilityScope,
        visibilityRevision: visibility.visibilityRevision + 1,
        sharedUserUids: input.visibilityScope === "shared" ? input.sharedUserUids : []
      };
      return visibility;
    },
    appendAudit: async (entry) => calls.push(["audit", entry]),
    listAuditLogs: async (query) => {
      auditQueries.push(query);
      return [{
        action: "skill.visibility.updated",
        resourceType: "skill",
        resourceId: skill.skillId,
        metadata: { visibilityScope: "shared", sharedUserUids: ["42002"] }
      }];
    }
  };
  server = createApiServer(config, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (catsServer) await new Promise((resolve) => catsServer.close(resolve));
});

test("catalogue forwards the logged-in CatsCo UID while public requests stay public", async () => {
  calls.length = 0;
  const publicResponse = await fetch(`${baseUrl}/api/skills`);
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(calls[0], ["list", { viewerUserId: null, viewerCatsCoUid: null, includeAll: false }]);

  calls.length = 0;
  const ownerResponse = await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerResponse.status, 200);
  assert.deepEqual(calls[0], ["list", { viewerUserId: "owner", viewerCatsCoUid: "42001", includeAll: false }]);
});

test("only the owner can change visibility and the mutation is audited", async () => {
  const forbidden = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    method: "PATCH",
    headers: { Cookie: foreignCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ visibilityScope: "private", expectedRevision: 1 })
  });
  assert.equal(forbidden.status, 403);

  calls.length = 0;
  const updated = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    method: "PATCH",
    headers: { Cookie: ownerCookie, "X-CatsCo-Access-Token": "cats-token", "Content-Type": "application/json" },
    body: JSON.stringify({ visibilityScope: "shared", sharedUserUids: ["42002"], expectedRevision: 1 })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(calls[0][0], "update");
  assert.equal(calls[0][1].actorUserId, "owner");
  assert.deepEqual(calls.find(([kind]) => kind === "audit")[1].metadata, {
    visibilityScope: "shared", sharedUserUids: ["42002"], sharedUserCount: 1, visibilityRevision: 2
  });

  calls.length = 0;
  const ownerCatalogue = await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: ownerCookie } });
  const granteeCatalogue = await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: granteeCookie } });
  const foreignCatalogue = await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: foreignCookie } });
  assert.match(ownerCatalogue.headers.get("cache-control") || "", /no-store/);
  assert.equal((await ownerCatalogue.json()).skills.length, 1);
  assert.equal((await granteeCatalogue.json()).skills.length, 1);
  assert.equal((await foreignCatalogue.json()).skills.length, 0);

  // A later request must observe the current policy after an ACL change;
  // there must be no stale viewer snapshot between requests.
  const beforeRevoke = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    headers: { Cookie: ownerCookie }
  });
  const beforeRevokeBody = await beforeRevoke.json();
  const staleRevoke = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    method: "PATCH",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ visibilityScope: "private", expectedRevision: beforeRevokeBody.visibility.visibilityRevision - 1 })
  });
  assert.equal(staleRevoke.status, 409);
  const privateUpdate = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    method: "PATCH",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ visibilityScope: "private", expectedRevision: beforeRevokeBody.visibility.visibilityRevision })
  });
  assert.equal(privateUpdate.status, 200);
  const privateUpdateBody = await privateUpdate.json();
  assert.equal(privateUpdateBody.visibility.visibilityRevision, beforeRevokeBody.visibility.visibilityRevision + 1);
  const granteeAfterRevoke = await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: granteeCookie } });
  assert.equal((await granteeAfterRevoke.json()).skills.length, 0);

  const beforeRestore = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    headers: { Cookie: ownerCookie }
  });
  const beforeRestoreBody = await beforeRestore.json();
  const publicUpdate = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/visibility`, {
    method: "PATCH",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ visibilityScope: "public", expectedRevision: beforeRestoreBody.visibility.visibilityRevision })
  });
  assert.equal(publicUpdate.status, 200);
  const publicUpdateBody = await publicUpdate.json();
  assert.equal(publicUpdateBody.visibility.visibilityRevision, beforeRestoreBody.visibility.visibilityRevision + 1);
  const foreignAfterRestore = await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: foreignCookie } });
  assert.equal((await foreignAfterRestore.json()).skills.length, 1);
});

test("only administrators can read filtered visibility audit records", async () => {
  const forbidden = await fetch(`${baseUrl}/api/admin/audit-logs?resourceType=skill&action=skill.visibility.updated`, {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(forbidden.status, 403);

  auditQueries.length = 0;
  const response = await fetch(
    `${baseUrl}/api/admin/audit-logs?resourceType=skill&action=skill.visibility.updated&actorUserId=owner&limit=25`,
    { headers: { Cookie: adminCookie } }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(auditQueries, [{
    action: "skill.visibility.updated",
    resourceType: "skill",
    actorUserId: "owner",
    limit: 25
  }]);
  assert.deepEqual((await response.json()).auditLogs[0].metadata.sharedUserUids, ["42002"]);
});

test("hidden skill details use the same ACL context as catalogue discovery", async () => {
  calls.length = 0;
  const response = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/versions/1.0.0`, {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["version", { viewerUserId: "owner", viewerCatsCoUid: "42001", includeAll: false }]);
});
