import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { createSessionToken, hashSessionToken } from "../../packages/auth/index.js";

let catsServer;
let skillHubServer;
let baseUrl;
let ownerCookie;
let calls;

before(async () => {
  catsServer = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer cats-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/me") {
      res.end(JSON.stringify({ uid: 85, username: "owner", display_name: "Owner", account_type: "human" }));
      return;
    }
    const uid = new URL(req.url, "http://cats.test").searchParams.get("q");
    if (req.url === `/api/users/search?q=${uid}&mode=uid`) {
      const user = uid === "951"
        ? { id: 951, username: "john", display_name: "John", account_type: "human" }
        : uid === "44"
          ? { id: 44, username: "agent", display_name: "Agent", account_type: "bot" }
          : null;
      res.end(JSON.stringify({ users: user ? [user] : [] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => catsServer.listen(0, "127.0.0.1", resolve));
  const catsBaseUrl = `http://127.0.0.1:${catsServer.address().port}`;
  const config = loadConfig({
    nodeEnv: "test",
    sessionSecret: "skill-visibility-human-targets-session-secret",
    catsCoBaseUrl: catsBaseUrl
  });
  const ownerToken = createSessionToken();
  ownerCookie = `${config.session.cookieName}=${ownerToken}`;
  const sessions = new Map([[hashSessionToken(ownerToken, config.session.secret), "owner"]]);
  calls = [];
  const store = {
    getSessionByTokenHash: async (hash) => sessions.has(hash) ? { userId: sessions.get(hash) } : null,
    getUserById: async (id) => ({ id, email: `${id}@example.com`, displayName: id }),
    getRoles: async () => ["user"],
    getDeveloperProfile: async () => ({ catsCoUid: "85" }),
    getSkillVisibility: async () => ({
      skillId: "demo/visibility",
      ownerUserId: "owner",
      visibilityScope: "public",
      visibilityRevision: 1,
      visibilityUpdatedAt: "2026-10-12T00:00:00.000Z",
      sharedUserUids: []
    }),
    updateSkillVisibility: async (input) => {
      calls.push(input);
      return {
        skillId: "demo/visibility",
        ownerUserId: "owner",
        visibilityScope: input.visibilityScope,
        visibilityRevision: 2,
        visibilityUpdatedAt: "2026-10-12T00:00:00.000Z",
        sharedUserUids: input.sharedUserUids
      };
    },
    appendAudit: async () => {}
  };
  skillHubServer = createApiServer(config, { store });
  await new Promise((resolve) => skillHubServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${skillHubServer.address().port}`;
});

after(async () => {
  if (skillHubServer) await new Promise((resolve) => skillHubServer.close(resolve));
  if (catsServer) await new Promise((resolve) => catsServer.close(resolve));
});

function patchVisibility(sharedUserUids, accessToken = "cats-token") {
  return fetch(`${baseUrl}/api/skills/demo%2Fvisibility/visibility`, {
    method: "PATCH",
    headers: {
      Cookie: ownerCookie,
      "X-CatsCo-Access-Token": accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ visibilityScope: "shared", sharedUserUids, expectedRevision: 1 })
  });
}

test("shared visibility accepts a human CatsCo account", async () => {
  const response = await patchVisibility(["951"]);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1).sharedUserUids, ["951"]);
});

test("shared visibility rejects a Bot UID before persistence", async () => {
  const response = await patchVisibility(["44"]);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "skill.visibility_target_invalid");
  assert.equal(calls.length, 1);
});
