import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { assertCatsCoIssuerMatches, requireCatsCoIssuer } from '../../packages/publication-delegation/identity.js';

const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

test("CatsCo exchange pins the authority and ignores forged publisher hints while creating a valid session", async () => {
  let forgedRequests = 0;
  const forgedAuthority = http.createServer((_req, res) => {
    forgedRequests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 999, username: "victim", display_name: "Forged" }));
  });
  await listen(forgedAuthority);
  cleanup.push(() => close(forgedAuthority));
  const catsCo = http.createServer((req, res) => {
    assert.equal(req.url, "/api/me");
    assert.equal(req.headers.authorization, "Bearer cats-token");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 85, username: "arrowhaken", display_name: "Verified" }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCo.address().port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const untrustedUrl = `http://127.0.0.1:${forgedAuthority.address().port}`;

  for (const authorityField of ["baseUrl", "httpBaseUrl"]) {
    const result = await post(`${baseUrl}/api/auth/catsco-exchange`, {
      token: "cats-token",
      [authorityField]: untrustedUrl,
      user: { uid: "999", username: "victim", displayName: "Forged" },
      catsCoIssuer: untrustedUrl, issuer: untrustedUrl
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.catsCo, { uid: "85", username: "arrowhaken", displayName: "Verified" });
    assert.equal(result.data.developerProfile.catsCoUid, "85");
    const cookie = result.response.headers.get("set-cookie");
    assert.ok(cookie, "legitimate exchange still creates a session");
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).developerProfile.catsCoUid, "85");
  }
  assert.equal(forgedRequests, 0);
  assert.equal(store.users.size, 1);
  assert.equal(store.profilesByCatsCoUid.has("999"), false);
  assert.equal(store.sessions.size, 2);
  assert.equal(store.profilesByCatsCoUid.get('85').catsco_issuer, `http://127.0.0.1:${catsCo.address().port}`);
});

test("exchange and profile sync fail closed on blank or invalid server authority without contacting request URLs", async () => {
  let forgedRequests = 0;
  const forgedAuthority = http.createServer((_req, res) => {
    forgedRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 999, username: "victim" }));
  });
  await listen(forgedAuthority);
  cleanup.push(() => close(forgedAuthority));
  const untrustedUrl = `http://127.0.0.1:${forgedAuthority.address().port}`;
  for (const authority of ["", "  ", "not-a-url", "ftp://example.invalid", undefined]) {
    const config = testConfig(authority);
    // Includes a missing field in a manually assembled config; normal unset
    // environment configuration still supplies loadConfig's trusted default.
    config.botAuth.catsCoBaseUrl = authority;
    config.presentations = { readEnabled: true, writeEnabled: true };
    const store = createMemoryStore();
    const api = createApiServer(config, { store });
    await listen(api);
    cleanup.push(() => close(api));
    for (const endpoint of ["catsco-exchange", "catsco-profile-sync"]) {
      for (const field of ["baseUrl", "httpBaseUrl"]) {
        const result = await post(`http://127.0.0.1:${api.address().port}/api/auth/${endpoint}`, {
          token: "local-test-only", [field]: untrustedUrl, user: { uid: "999" }
        });
        assert.equal(result.response.status, 503);
        assert.equal(result.data.error.code, "catsco.authority_unavailable");
        assert.match(result.data.error.message, /authority.*configured/);
        assert.equal(result.response.headers.get("set-cookie"), null);
      }
    }
    assert.equal(store.users.size, 0);
    assert.equal(store.sessions.size, 0);
    assert.equal(store.audits.length, 0);
  }
  assert.equal(forgedRequests, 0);
});

test("CatsCo exchange rejects a missing verified UID instead of using request-body hints", async () => {
  const catsCo = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ username: "verified-without-uid", display_name: "Verified" }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCo.address().port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const result = await post(`http://127.0.0.1:${api.address().port}/api/auth/catsco-exchange`, {
    token: "cats-token",
    baseUrl: `http://127.0.0.1:${catsCo.address().port}`,
    user: { uid: "999", username: "victim", displayName: "Forged" }
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.response.headers.get("set-cookie"), null);
  assert.equal(store.users.size, 0);
  assert.equal(store.sessions.size, 0);
  assert.equal(store.audits.length, 0);
});

test("CatsCo exchange derives missing display fields from verified identity, never from hints", async () => {
  const catsCo = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 85 }));
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCo.address().port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  const result = await post(`http://127.0.0.1:${api.address().port}/api/auth/catsco-exchange`, {
    token: "cats-token",
    baseUrl: `http://127.0.0.1:${catsCo.address().port}`,
    user: { uid: "999", username: "victim", displayName: "Forged" }
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.catsCo, { uid: "85", username: "catsco_85", displayName: "catsco_85" });
  assert.ok(result.response.headers.get("set-cookie"));
  assert.equal(store.profilesByCatsCoUid.has("999"), false);
});

test("CatsCo identity verification refuses redirects for exchange and profile sync", async () => {
  let redirectedRequests = 0;
  const destination = http.createServer((_req, res) => {
    redirectedRequests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 999, username: "victim", display_name: "Forged" }));
  });
  await listen(destination);
  cleanup.push(() => close(destination));
  const catsCo = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/api/me` });
    res.end();
  });
  await listen(catsCo);
  cleanup.push(() => close(catsCo));
  const store = createMemoryStore();
  const api = createApiServer(testConfig(`http://127.0.0.1:${catsCo.address().port}`), { store });
  await listen(api);
  cleanup.push(() => close(api));
  for (const endpoint of ["catsco-exchange", "catsco-profile-sync"]) {
    const result = await post(`http://127.0.0.1:${api.address().port}/api/auth/${endpoint}`, {
      token: "cats-token",
      baseUrl: `http://127.0.0.1:${catsCo.address().port}`
    });
    assert.equal(result.response.status, 502);
    assert.equal(result.response.headers.get("set-cookie"), null);
  }
  assert.equal(redirectedRequests, 0);
  assert.equal(store.users.size, 0);
  assert.equal(store.sessions.size, 0);
  assert.equal(store.audits.length, 0);
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
  assert.equal(store.profilesByUser.get('user-1').catsco_issuer, `http://127.0.0.1:${catsCoAddress.port}`);
  assert.deepEqual(store.audits.map((entry) => entry.action), [
    "auth.catsco_profile_sync",
    "auth.catsco_profile_sync"
  ]);
});

test("concurrent first-time CatsCo profile sync reuses one publisher identity", async () => {
  const catsCo = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer cats-token");
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
  const endpoint = `http://127.0.0.1:${apiAddress.port}/api/auth/catsco-profile-sync`;

  const [first, second] = await Promise.all([
    post(endpoint, { token: "cats-token" }),
    post(endpoint, { token: "cats-token" })
  ]);

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.data.developerProfile.userId, second.data.developerProfile.userId);
  assert.equal(store.users.size, 1);
  assert.equal(store.profilesByUser.size, 1);
  assert.equal(store.profilesByCatsCoUid.get("85").userId, first.data.developerProfile.userId);
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

test('exchanging a same-number UID from a changed authority cannot create a session or overwrite a bound profile', async () => {
  const store = createMemoryStore();
  const issuers = [];
  for (const displayName of ['Original', 'Other authority']) {
    const catsCo = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uid: 85, username: 'arrowhaken', display_name: displayName }));
    });
    await listen(catsCo);
    cleanup.push(() => close(catsCo));
    const api = createApiServer(testConfig(`http://127.0.0.1:${catsCo.address().port}`), { store });
    await listen(api);
    cleanup.push(() => close(api));
    issuers.push(`http://127.0.0.1:${api.address().port}`);
  }
  assert.equal((await post(`${issuers[0]}/api/auth/catsco-exchange`, { token: 'fixture' })).response.status, 200);
  const original = { ...store.profilesByCatsCoUid.get('85') };
  const auditCount = store.audits.length;
  for (const endpoint of ['catsco-exchange', 'catsco-profile-sync']) {
    const response = await post(`${issuers[1]}/api/auth/${endpoint}`, { token: 'fixture' });
    assert.equal(response.response.status, 409);
    assert.equal(response.data.error.code, 'catsco.publisher_issuer_conflict');
    assert.equal(response.response.headers.get('set-cookie'), null);
  }
  assert.equal(store.sessions.size, 1);
  assert.equal(store.audits.length, auditCount);
  assert.deepEqual(store.profilesByCatsCoUid.get('85'), original);
});

function createMemoryStore() {
  const users = new Map();
  const usersByEmail = new Map();
  const profilesByUser = new Map();
  const profilesByNamespace = new Map();
  const profilesByCatsCoUid = new Map();
  const sessions = new Map();
  const audits = [];
  return {
    users,
    profilesByUser,
    profilesByCatsCoUid,
    sessions,
    audits,
    async getRoles() {
      return ["user"];
    },
    async createSession(input) {
      sessions.set(input.tokenHash, input);
      return input;
    },
    async getSessionByTokenHash(tokenHash) {
      return sessions.get(tokenHash) || null;
    },
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
    async claimCatsCoPublisherIdentity(input) {
      const issuer = requireCatsCoIssuer(input.catsCoIssuer);
      const catsCoUid = String(input.catsCoUid ?? "").trim();
      const existing = profilesByCatsCoUid.get(catsCoUid) || null;
      assertCatsCoIssuerMatches(existing, issuer);
      const namespaceOwner = profilesByNamespace.get(input.namespace) || null;
      if (namespaceOwner && (!existing || namespaceOwner.userId !== existing.userId)) {
        const error = new Error("CatsCo publisher namespace is already linked to another account.");
        error.name = "ValidationError";
        error.code = "catsco.publisher_namespace_conflict";
        error.status = 409;
        throw error;
      }

      let user = existing ? users.get(existing.userId) : null;
      if (existing && !user) {
        const error = new Error("CatsCo publisher identity is inconsistent.");
        error.name = "ValidationError";
        error.code = "catsco.publisher_identity_inconsistent";
        error.status = 409;
        throw error;
      }
      if (!user) {
        user = {
          id: `user-${users.size + 1}`,
          email: input.internalEmail,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
          status: "active",
          emailVerified: true,
          createdAt: new Date().toISOString()
        };
        users.set(user.id, user);
        usersByEmail.set(user.email, user);
      } else {
        user.displayName = input.displayName;
      }

      if (existing) profilesByNamespace.delete(existing.namespace);
      const profile = {
        id: existing?.id || `profile-${profilesByUser.size + 1}`,
        userId: user.id,
        namespace: input.namespace,
        displayName: input.displayName,
        contact: input.contact,
        catsCoUid,
        catsco_issuer: existing ? existing.catsco_issuer : issuer
      };
      profilesByUser.set(user.id, profile);
      profilesByNamespace.set(input.namespace, profile);
      profilesByCatsCoUid.set(catsCoUid, profile);
      return { user, developerProfile: profile };
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
