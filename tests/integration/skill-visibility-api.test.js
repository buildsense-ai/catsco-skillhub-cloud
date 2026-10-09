import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { createSessionToken, hashSessionToken } from "../../packages/auth/index.js";

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
let baseUrl;
let ownerCookie;
let foreignCookie;
let calls;
let visibility;

before(async () => {
  const config = loadConfig({ nodeEnv: "test", sessionSecret: "visibility-test-session-secret" });
  const ownerToken = createSessionToken();
  const foreignToken = createSessionToken();
  ownerCookie = `${config.session.cookieName}=${ownerToken}`;
  foreignCookie = `${config.session.cookieName}=${foreignToken}`;
  const sessions = new Map([
    [hashSessionToken(ownerToken, config.session.secret), "owner"],
    [hashSessionToken(foreignToken, config.session.secret), "foreign"]
  ]);
  calls = [];
  visibility = {
    skillId: skill.skillId,
    ownerUserId: "owner",
    visibilityScope: "public",
    visibilityRevision: 1,
    visibilityUpdatedAt: "2026-10-09T00:00:00.000Z",
    sharedUserUids: []
  };
  const store = {
    getSessionByTokenHash: async (hash) => sessions.has(hash) ? { userId: sessions.get(hash) } : null,
    getUserById: async (id) => ({ id, email: `${id}@example.com`, displayName: id }),
    getRoles: async () => ["user"],
    getDeveloperProfile: async (id) => id === "owner" ? { catsCoUid: "42001" } : { catsCoUid: "42002" },
    listPublishedVersions: async (viewer) => { calls.push(["list", viewer]); return [skill]; },
    listPublishedVersionsForSkill: async (_skillId, viewer) => { calls.push(["detail", viewer]); return [skill]; },
    findPublishedVersion: async (_skillId, _version, viewer) => { calls.push(["version", viewer]); return skill; },
    getSkillVisibility: async () => ({ ...visibility, sharedUserUids: [...visibility.sharedUserUids] }),
    updateSkillVisibility: async (input) => {
      calls.push(["update", input]);
      visibility = {
        ...visibility,
        visibilityScope: input.visibilityScope,
        visibilityRevision: visibility.visibilityRevision + 1,
        sharedUserUids: input.visibilityScope === "shared" ? input.sharedUserUids : []
      };
      return visibility;
    },
    appendAudit: async (entry) => calls.push(["audit", entry])
  };
  server = createApiServer(config, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
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
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ visibilityScope: "shared", sharedUserUids: ["42002"], expectedRevision: 1 })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(calls[0][0], "update");
  assert.equal(calls[0][1].actorUserId, "owner");
  assert.deepEqual(calls.find(([kind]) => kind === "audit")[1].metadata, {
    visibilityScope: "shared", sharedUserCount: 1, visibilityRevision: 2
  });
});

test("hidden skill details use the same ACL context as catalogue discovery", async () => {
  calls.length = 0;
  const response = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skill.skillId)}/versions/1.0.0`, {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["version", { viewerUserId: "owner", viewerCatsCoUid: "42001", includeAll: false }]);
});
