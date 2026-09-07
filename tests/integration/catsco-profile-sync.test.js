import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";

const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

test("CatsCo profile sync updates publisher identity without creating a SkillHub session", async () => {
  let displayName = "arrowhaken1";
  const catsCo = http.createServer((req, res) => {
    assert.equal(req.url, "/api/me");
    assert.equal(req.headers.authorization, "Bearer cats-token");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 85, username: "arrowhaken", display_name: displayName }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));

  const catsCoAddress = catsCo.address();
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCoAddress.port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));

  const apiAddress = api.address();
  const endpoint = `http://127.0.0.1:${apiAddress.port}/api/auth/catsco-profile-sync`;
  const requestBody = () => ({
    baseUrl: "https://attacker.invalid",
    token: "cats-token",
    user: {
      uid: "999",
      username: "spoofed",
      displayName: "spoofed"
    }
  });

  const first = await post(endpoint, requestBody());
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("set-cookie"), null);
  assert.equal(first.data.synced, true);
  assert.equal(first.data.developerProfile.displayName, "arrowhaken1");
  assert.equal(first.data.developerProfile.contact, "catsco:85");
  assert.deepEqual(first.data.catsCo, {
    uid: "85",
    username: "arrowhaken",
    displayName: "arrowhaken1"
  });

  displayName = "arrowhaken";
  const second = await post(endpoint, requestBody());
  assert.equal(second.response.status, 200);
  assert.equal(second.response.headers.get("set-cookie"), null);
  assert.equal(second.data.developerProfile.displayName, "arrowhaken");
  assert.equal(store.users.size, 1);
  assert.equal(store.profilesByUser.get("user-1").displayName, "arrowhaken");
  assert.deepEqual(store.audits.map((entry) => entry.action), [
    "auth.catsco_profile_sync",
    "auth.catsco_profile_sync"
  ]);
});

test("CatsCo profile sync rejects a missing token without touching publisher data", async () => {
  const store = createMemoryStore();
  const api = createApiServer(testConfig(), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const address = api.address();

  const result = await post(
    `http://127.0.0.1:${address.port}/api/auth/catsco-profile-sync`,
    { baseUrl: "https://app.catsco.cc" }
  );
  assert.equal(result.response.status, 401);
  assert.equal(store.users.size, 0);
  assert.equal(store.profilesByUser.size, 0);
});

test("CatsCo profile sync rejects a namespace already owned by another verified UID", async () => {
  const catsCo = http.createServer((req, res) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/, "");
    const uid = token === "cats-token-b" ? 86 : 85;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid, username: "same-name", display_name: `User ${uid}` }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));

  const catsCoAddress = catsCo.address();
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCoAddress.port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const apiAddress = api.address();
  const endpoint = `http://127.0.0.1:${apiAddress.port}/api/auth/catsco-profile-sync`;

  const first = await post(endpoint, { token: "cats-token-a" });
  assert.equal(first.response.status, 200);
  const second = await post(endpoint, { token: "cats-token-b" });
  assert.equal(second.response.status, 409);
  assert.equal(second.data.error?.code, "catsco.publisher_namespace_conflict");
  assert.equal(store.users.size, 1);
  assert.equal(store.profilesByUser.get("user-1").contact, "catsco:85");
});

test("public registration cannot preclaim an internal CatsCo publisher identity", async () => {
  const catsCo = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 85, username: "arrowhaken", display_name: "arrowhaken" }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));

  const catsCoAddress = catsCo.address();
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCoAddress.port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const apiAddress = api.address();
  const baseUrl = `http://127.0.0.1:${apiAddress.port}`;
  const attackerEmail = "catsco-85@catsco.local";
  const attackerPassword = "attacker-password";

  const registration = await post(`${baseUrl}/api/auth/register`, {
    email: attackerEmail,
    password: attackerPassword,
    displayName: "attacker"
  });
  assert.equal(registration.response.status, 400);
  assert.equal(registration.data.error?.code, "email.reserved");

  const sync = await post(`${baseUrl}/api/auth/catsco-profile-sync`, { token: "cats-token" });
  assert.equal(sync.response.status, 200);
  assert.equal(sync.data.developerProfile.catsCoUid, "85");

  const login = await post(`${baseUrl}/api/auth/login`, {
    email: attackerEmail,
    password: attackerPassword
  });
  assert.equal(login.response.status, 401);
  assert.equal(store.users.size, 1);
  assert.equal(store.profilesByCatsCoUid.get("85").userId, "user-1");
});

test("a legacy preclaimed synthetic email is never adopted as a verified CatsCo identity", async () => {
  const catsCo = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 85, username: "arrowhaken", display_name: "arrowhaken" }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));

  const catsCoAddress = catsCo.address();
  const store = createMemoryStore();
  const attacker = await store.createUser({
    email: "catsco-85@catsco.local",
    passwordHash: "attacker-password-hash",
    displayName: "attacker"
  });
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCoAddress.port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const apiAddress = api.address();

  const sync = await post(
    `http://127.0.0.1:${apiAddress.port}/api/auth/catsco-profile-sync`,
    { token: "cats-token" }
  );
  assert.equal(sync.response.status, 200);
  assert.equal(store.users.size, 2);
  assert.equal(store.profilesByUser.has(attacker.id), false);
  assert.notEqual(store.profilesByCatsCoUid.get("85").userId, attacker.id);
});

function createMemoryStore() {
  const users = new Map();
  const usersByEmail = new Map();
  const profilesByUser = new Map();
  const profilesByNamespace = new Map();
  const profilesByCatsCoUid = new Map();
  const audits = [];
  return {
    users,
    profilesByUser,
    profilesByCatsCoUid,
    audits,
    async getDeveloperProfileByNamespace(namespace) {
      return profilesByNamespace.get(namespace) || null;
    },
    async getDeveloperProfileByCatsCoUid(catsCoUid) {
      return profilesByCatsCoUid.get(String(catsCoUid)) || null;
    },
    async getUserById(id) {
      return users.get(id) || null;
    },
    async getUserByEmail(email) {
      return usersByEmail.get(email) || null;
    },
    async createUser(input) {
      const user = {
        id: `user-${users.size + 1}`,
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        status: "active",
        emailVerified: true,
        createdAt: new Date().toISOString()
      };
      users.set(user.id, user);
      usersByEmail.set(user.email, user);
      return user;
    },
    async ensureDeveloperProfile(input) {
      const existing = profilesByUser.get(input.userId);
      if (existing) {
        profilesByNamespace.delete(existing.namespace);
        if (existing.catsCoUid) profilesByCatsCoUid.delete(existing.catsCoUid);
      }
      const profile = {
        ...input,
        catsCoUid: String(input.catsCoUid ?? "").trim() || existing?.catsCoUid || null
      };
      profilesByUser.set(input.userId, profile);
      profilesByNamespace.set(input.namespace, profile);
      if (profile.catsCoUid) profilesByCatsCoUid.set(profile.catsCoUid, profile);
      return profile;
    },
    async getDeveloperProfile(userId) {
      return profilesByUser.get(userId) || null;
    },
    async grantRole() {},
    async appendAudit(entry) {
      audits.push(entry);
    }
  };
}

function testConfig(catsCoBaseUrl = "https://app.catsco.cc") {
  return loadConfig({
    root: "unused",
    storageRoot: "unused/storage",
    logsRoot: "unused/logs",
    sharedRoot: "unused/shared",
    databaseUrl: "postgres://unused",
    publicBaseUrl: "http://127.0.0.1",
    sessionSecret: "test-session-secret-that-is-long-enough-for-tests",
    catsCoBaseUrl,
    allowAutoKeygen: true,
    nodeEnv: "test"
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, data: await response.json() };
}
