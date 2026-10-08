import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { parsePresentationContent, parsePresentationWrite, assertPresentationEditor } from "../../packages/presentations/index.js";

const content = { schemaVersion: 1, summary: "读取用户提供的文档", primaryCategory: "documents" };
const owner = { userId: "owner", role: "user", roles: ["user"] };

test("presentation validates bounded structured plain text without executable fields", () => {
  const parsed = parsePresentationContent({ ...content, tags: ["文档", "文档"], example: { kind: "document", input: "文档", output: "摘要" } });
  assert.deepEqual(parsed.tags, ["文档"]);
  assert.equal(parsed.details, "");
  for (const bad of [
    null, [], { ...content, schemaVersion: 2 }, { ...content, summary: " " },
    { ...content, summary: "x".repeat(241) }, { ...content, summary: "\u0000secret" },
    { ...content, summary: "\ud800" }, { ...content, summary: "\udfff" },
    { ...content, primaryCategory: "unknown" }, { ...content, tags: Array(6).fill("tag") },
    { ...content, html: "<script>alert(1)</script>" }, { ...content, imageUrl: "http://localhost/private" },
    { ...content, example: { kind: "image", input: "x", output: "y", assetId: "unverified" } },
    { ...content, scenarios: [{ title: "a", description: "b", onclick: "evil()" }] },
    JSON.parse('{"schemaVersion":1,"summary":"x","primaryCategory":"other","__proto__":{}}')
  ]) assert.throws(() => parsePresentationContent(bad), { code: "presentation.invalid" });
  // Technical syntax is stored as inert JSON text, not interpreted HTML.
  assert.equal(parsePresentationContent({ ...content, details: "<script>example</script>" }).details, "<script>example</script>");
  assert.equal(parsePresentationContent({ ...content, summary: "文档 📚" }).summary, "文档 📚");
});

test("presentation mutation rejects forged identity, package hash, revision and private target fields", () => {
  const base = { skillId: "author/read", version: "1.0.0", expectedRevision: 0, content };
  for (const patch of [
    { payerUID: 1 }, { author: "owner" }, { sourceContentHash: "fake" }, { expectedRevision: "0" },
    { expectedRevision: -1 }, { expectedRevision: 2147483647 }, { skillId: "priv_foo" },
    { skillId: "../read" }, { version: "latest" }, { skillId: "author/read/extra" }
  ]) assert.throws(() => parsePresentationWrite({ ...base, ...patch }, "draft"));
  assert.throws(() => parsePresentationWrite(base, "publish"), { code: "presentation.invalid" });
  assert.throws(() => assertPresentationEditor({ role: "agent" }, "owner"), { status: 401 });
  assert.throws(() => assertPresentationEditor(owner, "someone-else"), { status: 404 });
  const admin = { userId: "admin", role: "admin", roles: ["user", "admin"] };
  assert.throws(() => assertPresentationEditor(admin, "owner", "", true), { code: "presentation.invalid" });
  assert.doesNotThrow(() => assertPresentationEditor(admin, "owner", "Moderation correction", true));
});

async function withApi(t, overrides = {}) {
  const calls = [];
  const config = loadConfig({ nodeEnv: "test", sessionSecret: "local-test-only", agentClientSecret: "test-agent-secret", ...overrides });
  const versions = Array.from({ length: 35 }, (_, i) => ({
    skillId: `author/skill-${i}`, version: "1.0.0", skillName: `skill-${i}`, displayName: `Skill ${i}`,
    status: "published", publishedAt: "2026-10-08T00:00:00.000Z", manifest: { categories: ["documents"] }
  }));
  const store = {
    getSessionByTokenHash: async () => ({ userId: "owner" }),
    getUserById: async () => ({ id: "owner", displayName: "Owner" }),
    getRoles: async () => ["user"],
    getDeveloperProfile: async () => null,
    getSkillPresentation: async (arg) => { calls.push(arg); return arg.draft ? { revision: 0, draft: null } : null; },
    writeSkillPresentation: async (...args) => { calls.push(args); return { revision: 1 }; },
    listCatalogueVersions: async () => versions,
    listPublishedVersions: async () => versions
  };
  const server = createApiServer(config, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => {
    const response = await fetch(baseUrl + url, options);
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  return { request, calls, config };
}

const draftBody = { skillId: "author/read", version: "1.0.0", expectedRevision: 0, content };
const writeOptions = (extra = {}) => ({ method: "PUT", headers: { "Content-Type": "application/json", Cookie: "catsco_session=local-cookie", ...extra }, body: JSON.stringify(draftBody) });

test("public and owner-only presentation routes are separated, never authenticate with agent secret", async (t) => {
  const { request, calls } = await withApi(t);
  const target = "?skillId=author%2Fread&version=1.0.0";
  const publicResult = await request("/api/skill-presentations" + target);
  assert.equal(publicResult.status, 200);
  assert.deepEqual(publicResult.data, { presentation: null });
  assert.match(publicResult.headers.get("cache-control"), /no-store/);
  assert.equal(calls[0].actor, undefined);
  for (const headers of [{}, { Authorization: "Bearer test-agent-secret" }, { Authorization: "ApiKey bot-key" }]) {
    assert.equal((await request("/api/skill-presentations/draft" + target, { headers })).status, 401);
    const options = writeOptions();
    options.headers = { "Content-Type": "application/json", ...headers };
    assert.equal((await request("/api/skill-presentations/draft", options)).status, 401);
  }
  const editable = await request("/api/skill-presentations/draft" + target, { headers: { Cookie: "catsco_session=local-cookie" } });
  assert.equal(editable.status, 200);
  assert.equal(calls.at(-1).actor.userId, "owner");
  assert.equal((await request("/api/skill-presentations/draft", writeOptions())).status, 200);
  assert.equal(calls.at(-1)[1].userId, "owner");
  assert.equal(calls.at(-1)[2], "draft");
});

test("cookie writes reject foreign origins, non-JSON, oversized and unsupported fields before storage", async (t) => {
  const { request, calls } = await withApi(t, { allowedOrigins: ["https://app.catsco.cc"] });
  for (const [options, status] of [
    [writeOptions({ Origin: "https://attacker.invalid" }), 403],
    [writeOptions({ Origin: "null" }), 403],
    [writeOptions({ "Content-Type": "text/plain" }), 415],
    [{ ...writeOptions(), body: JSON.stringify({ ...draftBody, payerUID: 85 }) }, 400],
    [{ ...writeOptions(), body: JSON.stringify({ ...draftBody, padding: "x".repeat(50 * 1024) }) }, 413]
  ]) assert.equal((await request("/api/skill-presentations/draft", options)).status, status);
  assert.equal(calls.length, 0);
  assert.equal((await request("/api/skill-presentations/draft", writeOptions({ Origin: "https://app.catsco.cc" }))).status, 200);
});

test("publish and unpublish copy server drafts instead of accepting client replacement content", async (t) => {
  const { request, calls } = await withApi(t);
  for (const action of ["publish", "unpublish"]) {
    const options = { ...writeOptions(), method: "POST" };
    assert.equal((await request(`/api/skill-presentations/${action}`, options)).status, 400);
    options.body = JSON.stringify({ skillId: "author/read", version: "1.0.0", expectedRevision: 1 });
    assert.equal((await request(`/api/skill-presentations/${action}`, options)).status, 200);
    assert.equal(calls.at(-1)[2], action);
  }
});

test("new catalogue API pages beyond 30 while the legacy response stays compatible", async (t) => {
  const { request } = await withApi(t);
  const old = await request("/api/skills");
  assert.equal(old.data.skills.length, 30);
  assert.deepEqual(Object.keys(old.data), ["skills"]);
  const first = await request("/api/catalogue/skills?limit=20&category=documents");
  assert.equal(first.status, 200);
  assert.equal(first.data.skills.length, 20);
  assert.equal(first.data.total, 35);
  assert.deepEqual(first.data.categoryCounts, [{ category: "documents", count: 35 }]);
  const second = await request(`/api/catalogue/skills?limit=20&category=documents&cursor=${first.data.nextCursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.data.skills.length, 15);
  assert.equal(second.data.nextCursor, null);
  for (const limit of ["", "0", "101", "-1", "1.5", "abc", "1e2"]) {
    assert.equal((await request(`/api/catalogue/skills?limit=${limit}`)).status, 400);
  }
  assert.equal((await request("/api/catalogue/categories")).data.categories.length, 8);
  assert.equal((await request("/api/catalogue/skills?category=missing")).data.skills.length, 0);
});

test("rollout switches do not disable old catalogue operations", async (t) => {
  const { request } = await withApi(t, { presentationsReadEnabled: false, presentationsWriteEnabled: false });
  assert.equal((await request("/api/catalogue/skills")).status, 503);
  assert.equal((await request("/api/skills")).status, 200);
  const readOnly = await withApi(t, { presentationsReadEnabled: true, presentationsWriteEnabled: false });
  assert.equal((await readOnly.request("/api/catalogue/skills")).status, 200);
  assert.equal((await readOnly.request("/api/skill-presentations/draft", writeOptions())).status, 503);
  const production = loadConfig({ nodeEnv: "production" });
  assert.equal(production.presentations.readEnabled, false);
  assert.equal(production.presentations.writeEnabled, false);
});
