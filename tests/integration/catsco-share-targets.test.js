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
let foreignCookie;
let catsRequests;

before(async () => {
  catsRequests = [];
  catsServer = http.createServer((req, res) => {
    catsRequests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer cats-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/me") {
      res.end(JSON.stringify({ uid: 85, username: "arrowhaken", display_name: "Arrow Haken" }));
      return;
    }
    if (req.url === "/api/friends") {
      res.end(JSON.stringify({ friends: [
        { id: 951, username: "john", display_name: "John", email: "private@example.com" },
        { id: 12, username: "friend-two", display_name: "Friend Two", avatar_url: "private" }
      ] }));
      return;
    }
    if (req.url === "/api/users/search?q=john&mode=name") {
      res.end(JSON.stringify({ users: [
        { id: 951, username: "john", display_name: "John", email: "private@example.com" }
      ] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => catsServer.listen(0, "127.0.0.1", resolve));
  const catsBaseUrl = `http://127.0.0.1:${catsServer.address().port}`;

  const config = loadConfig({
    nodeEnv: "test",
    sessionSecret: "catsco-share-targets-test-session-secret",
    catsCoBaseUrl: catsBaseUrl
  });
  const ownerToken = createSessionToken();
  const foreignToken = createSessionToken();
  ownerCookie = `${config.session.cookieName}=${ownerToken}`;
  foreignCookie = `${config.session.cookieName}=${foreignToken}`;
  const sessions = new Map([
    [hashSessionToken(ownerToken, config.session.secret), "owner"],
    [hashSessionToken(foreignToken, config.session.secret), "foreign"]
  ]);
  const store = {
    getSessionByTokenHash: async (hash) => sessions.has(hash) ? { userId: sessions.get(hash) } : null,
    getUserById: async (id) => ({ id, email: `${id}@example.com`, displayName: id }),
    getRoles: async () => ["user"],
    getDeveloperProfile: async (id) => id === "owner" ? { catsCoUid: "85" } : { catsCoUid: "951" }
  };
  skillHubServer = createApiServer(config, { store });
  await new Promise((resolve) => skillHubServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${skillHubServer.address().port}`;
});

after(async () => {
  if (skillHubServer) await new Promise((resolve) => skillHubServer.close(resolve));
  if (catsServer) await new Promise((resolve) => catsServer.close(resolve));
});

test("share target APIs return minimal friend and username fields", async () => {
  const friends = await fetch(`${baseUrl}/api/catsco/share-targets/friends`, {
    headers: { Cookie: ownerCookie, "X-CatsCo-Access-Token": "cats-token" }
  });
  assert.equal(friends.status, 200);
  assert.deepEqual(await friends.json(), {
    users: [
      { uid: "951", username: "john", displayName: "John" },
      { uid: "12", username: "friend-two", displayName: "Friend Two" }
    ]
  });

  const search = await fetch(`${baseUrl}/api/catsco/share-targets/search?q=john`, {
    headers: { Cookie: ownerCookie, "X-CatsCo-Access-Token": "cats-token" }
  });
  assert.equal(search.status, 200);
  assert.deepEqual(await search.json(), {
    users: [{ uid: "951", username: "john", displayName: "John" }]
  });
  assert.deepEqual(catsRequests.map((request) => request.path), [
    "/api/me", "/api/friends", "/api/me", "/api/users/search?q=john&mode=name"
  ]);
});

test("share target APIs require the current CatsCo identity", async () => {
  const missingToken = await fetch(`${baseUrl}/api/catsco/share-targets/friends`, {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(missingToken.status, 401);

  const mismatchedToken = await fetch(`${baseUrl}/api/catsco/share-targets/friends`, {
    headers: { Cookie: foreignCookie, "X-CatsCo-Access-Token": "cats-token" }
  });
  assert.equal(mismatchedToken.status, 403);

  const shortQuery = await fetch(`${baseUrl}/api/catsco/share-targets/search?q=a`, {
    headers: { Cookie: ownerCookie, "X-CatsCo-Access-Token": "cats-token" }
  });
  assert.equal(shortQuery.status, 400);
});
