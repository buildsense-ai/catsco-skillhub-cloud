import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { closePools } from "../../packages/database/store.js";
import { sha256 } from "../../packages/domain/index.js";
import { computePrivateSkillContentHash } from "../../packages/private-skills/index.js";

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;
const mutationWriterSecret = "test-private-mutation-writer-secret-20260822";
const suffix = `${Date.now().toString(36)}-${process.pid}`;
let root;
let upstream;
let server;
let baseUrl;
let upstreamBaseUrl;

before(async () => {
  if (!databaseUrl) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-private-flow-"));
  upstream = http.createServer((req, res) => {
    const key = String(req.headers.authorization ?? "").replace(/^ApiKey /, "");
    const uid = key === "bot-key-a" ? "42001" : key === "bot-key-b" ? "42002" : "";
    if (!uid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const config = loadConfig({
    root,
    storageRoot: path.join(root, "storage"),
    logsRoot: path.join(root, "logs"),
    sharedRoot: path.join(root, "shared"),
    databaseUrl,
    sessionSecret: "test-session-secret-that-is-long-enough-for-tests",
    catsCoBaseUrl: upstreamBaseUrl,
    privateSkillMaxConcurrentUploads: 16,
    mutationWriterEnabled: true,
    mutationWriterSecret,
    nodeEnv: "test"
  });
  server = createApiServer(config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (root) await fs.rm(root, { recursive: true, force: true });
  await closePools();
});

test("private Bot packages are idempotent, immutable, and isolated by Bot", { skip: !databaseUrl }, async () => {
  const firstBody = packageBody(`private-${suffix}`, "# Private v1\n");
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => request("PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", firstBody))
  );
  assert.ok(concurrent.every((item) => [200, 201].includes(item.status)));
  const references = new Set(concurrent.map((item) => JSON.stringify(item.data.reference)));
  assert.equal(references.size, 1);
  const first = concurrent[0].data;

  const downloaded = await request(
    "GET",
    packagePath(first.reference),
    "bot-key-a",
    "42001"
  );
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.data.contentHash, firstBody.contentHash);
  assert.equal(downloaded.data.files[0].contentBase64, firstBody.files[0].contentBase64);

  const metadata = await request(
    "POST",
    "/api/bot/private-skill-metadata",
    "bot-key-a",
    "42001",
    { references: [first.reference, { skillId: `priv_${"f".repeat(40)}`, version: "missing" }] }
  );
  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.data.skills, [{
    source: "skillhub",
    skillId: first.reference.skillId,
    version: first.reference.version,
    displayName: firstBody.name,
    revisionNumber: 1,
    changeSource: "runtime_backup",
    lastChangedAt: metadata.data.skills[0].lastChangedAt
  }]);
  assert.match(metadata.data.skills[0].lastChangedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Object.hasOwn(metadata.data.skills[0], "lastChangedByUserUid"), false);
  assert.deepEqual(Object.keys(metadata.data.skills[0]).sort(), [
    "changeSource", "displayName", "lastChangedAt", "revisionNumber", "skillId", "source", "version"
  ]);

  const metadataHiddenFromOtherBot = await request(
    "POST",
    "/api/bot/private-skill-metadata",
    "bot-key-b",
    "42002",
    { references: [first.reference] }
  );
  assert.equal(metadataHiddenFromOtherBot.status, 200);
  assert.deepEqual(metadataHiddenFromOtherBot.data.skills, []);

  const hiddenFromOtherBot = await request(
    "GET",
    packagePath(first.reference),
    "bot-key-b",
    "42002"
  );
  assert.equal(hiddenFromOtherBot.status, 404);
  assert.equal(hiddenFromOtherBot.data.error.code, "PRIVATE_SKILL_NOT_FOUND");

  const mismatchedHeader = await request(
    "GET",
    packagePath(first.reference),
    "bot-key-a",
    "42002"
  );
  assert.equal(mismatchedHeader.status, 403);
  assert.equal(mismatchedHeader.data.error.code, "BOT_BINDING_MISMATCH");

  const secondBody = packageBody(firstBody.localSkillId, "# Private v2\n");
  const second = await request("PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", secondBody);
  assert.equal(second.status, 201);
  assert.equal(second.data.reference.skillId, first.reference.skillId);
  assert.notEqual(second.data.reference.version, first.reference.version);

  const secondMetadata = await request(
    "POST",
    "/api/bot/private-skill-metadata",
    "bot-key-a",
    "42001",
    { references: [second.data.reference] }
  );
  assert.equal(secondMetadata.status, 200, JSON.stringify(secondMetadata.data));
  assert.equal(secondMetadata.data.skills[0].revisionNumber, 2);
  assert.equal(secondMetadata.data.skills[0].changeSource, "runtime_backup");

  const changedBackToFirst = await mutationRequest({
    mutationId: Date.now() + process.pid,
    grantId: `grant-${suffix}`,
    botUid: "42001",
    localSkillId: firstBody.localSkillId,
    name: firstBody.name,
    actorUserUid: 7,
    sourceTopicId: `topic-${suffix}`,
    sourceMessageId: 1001,
    runtimeBodyId: `runtime-${suffix}`,
    clientRequestId: `request-${suffix}`,
    operation: "replace",
    candidateContentHash: firstBody.contentHash,
    candidateSizeBytes: firstBody.files.reduce((total, file) => total + file.size, 0),
    expectedPreviousHash: secondBody.contentHash,
    beforeReference: {
      source: "skillhub",
      skillId: second.data.reference.skillId,
      version: second.data.reference.version,
      contentHash: secondBody.contentHash
    },
    files: firstBody.files
  });
  assert.equal(changedBackToFirst.status, 201);

  const changedMetadata = await request(
    "POST",
    "/api/bot/private-skill-metadata",
    "bot-key-a",
    "42001",
    { references: [first.reference] }
  );
  assert.equal(changedMetadata.data.skills[0].revisionNumber, 1);
  assert.equal(changedMetadata.data.skills[0].changeSource, "conversation_mutation");
  assert.equal(Object.hasOwn(changedMetadata.data.skills[0], "lastChangedByUserUid"), false);
  assert.ok(
    Date.parse(changedMetadata.data.skills[0].lastChangedAt)
      >= Date.parse(metadata.data.skills[0].lastChangedAt)
  );

  const history = await request(
    "POST",
    "/api/bot/private-skill-history",
    "bot-key-a",
    "42001",
    { skillId: first.reference.skillId }
  );
  assert.equal(history.status, 200, JSON.stringify(history.data));
  assert.deepEqual(history.data.versions.map((item) => ({
    version: item.version,
    revisionNumber: item.revisionNumber,
    changeSource: item.changeSource
  })), [{
    version: second.data.reference.version,
    revisionNumber: 2,
    changeSource: "runtime_backup"
  }, {
    version: first.reference.version,
    revisionNumber: 1,
    changeSource: "conversation_mutation"
  }]);
  assert.equal(history.data.nextBeforeRevisionNumber, null);
  assert.ok(history.data.versions.every((item) => /^\d{4}-\d{2}-\d{2}T/.test(item.lastChangedAt)));
  assert.ok(history.data.versions.every((item) => item.displayName === firstBody.name));
  assert.deepEqual(Object.keys(history.data.versions[0]).sort(), [
    "changeSource", "displayName", "lastChangedAt", "revisionNumber", "skillId", "source", "version"
  ]);

  const firstPage = await request(
    "POST",
    "/api/bot/private-skill-history",
    "bot-key-a",
    "42001",
    { skillId: first.reference.skillId, limit: 1 }
  );
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.data.versions.length, 1);
  assert.equal(firstPage.data.versions[0].revisionNumber, 2);
  assert.equal(firstPage.data.nextBeforeRevisionNumber, 2);
  const secondPage = await request(
    "POST",
    "/api/bot/private-skill-history",
    "bot-key-a",
    "42001",
    {
      skillId: first.reference.skillId,
      limit: 1,
      beforeRevisionNumber: firstPage.data.nextBeforeRevisionNumber
    }
  );
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.data.versions.length, 1);
  assert.equal(secondPage.data.versions[0].revisionNumber, 1);
  assert.equal(secondPage.data.nextBeforeRevisionNumber, null);

  const historyHiddenFromOtherBot = await request(
    "POST",
    "/api/bot/private-skill-history",
    "bot-key-b",
    "42002",
    { skillId: first.reference.skillId }
  );
  assert.equal(historyHiddenFromOtherBot.status, 200);
  assert.deepEqual(historyHiddenFromOtherBot.data, {
    skillId: first.reference.skillId,
    versions: [],
    nextBeforeRevisionNumber: null
  });

  const oldStillExists = await request("GET", packagePath(first.reference), "bot-key-a", "42001");
  assert.equal(oldStillExists.status, 200);
  assert.equal(oldStillExists.data.contentHash, firstBody.contentHash);
});

test("active idempotent private packages do not consume upload write quota", { skip: !databaseUrl }, async (t) => {
  const limitedRoot = path.join(root, "limited-upload-rate");
  const limitedConfig = loadConfig({
    root: limitedRoot,
    storageRoot: path.join(limitedRoot, "storage"),
    logsRoot: path.join(limitedRoot, "logs"),
    sharedRoot: path.join(limitedRoot, "shared"),
    databaseUrl,
    sessionSecret: "test-session-secret-that-is-long-enough-for-tests",
    catsCoBaseUrl: upstreamBaseUrl,
    privateSkillMaxConcurrentUploads: 16,
    privateSkillMaxUploadsPerMinute: 2,
    nodeEnv: "test"
  });
  const limitedServer = createApiServer(limitedConfig);
  await new Promise((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => limitedServer.close(resolve)));
  const address = limitedServer.address();
  const limitedBaseUrl = `http://127.0.0.1:${address.port}`;

  const firstBody = packageBody(`rate-first-${suffix}`, "# Rate first\n");
  const first = await requestAt(limitedBaseUrl, "PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", firstBody);
  assert.equal(first.status, 201);

  for (let index = 0; index < 5; index += 1) {
    const repeated = await requestAt(limitedBaseUrl, "PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", firstBody);
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.data.reference, first.data.reference);
  }

  const secondBody = packageBody(`rate-second-${suffix}`, "# Rate second\n");
  const second = await requestAt(limitedBaseUrl, "PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", secondBody);
  assert.equal(second.status, 201);

  const secondRepeated = await requestAt(limitedBaseUrl, "PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", secondBody);
  assert.equal(secondRepeated.status, 200);

  const thirdBody = packageBody(`rate-third-${suffix}`, "# Rate third\n");
  const limited = await requestAt(limitedBaseUrl, "PUT", "/api/bot/private-skill-packages", "bot-key-a", "42001", thirdBody);
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, "PRIVATE_SKILL_RATE_LIMITED");
});

function packageBody(localSkillId, text) {
  const bytes = Buffer.from(text);
  const files = [{
    path: "SKILL.md",
    size: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64")
  }];
  return {
    localSkillId,
    name: "private-test",
    contentHash: computePrivateSkillContentHash(files),
    files
  };
}

function packagePath(reference) {
  return `/api/bot/skill-packages/${encodeURIComponent(reference.skillId)}/versions/${encodeURIComponent(reference.version)}`;
}

async function request(method, pathname, apiKey, botId, body) {
  return requestAt(baseUrl, method, pathname, apiKey, botId, body);
}

async function requestAt(requestBaseUrl, method, pathname, apiKey, botId, body) {
  const response = await fetch(`${requestBaseUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `ApiKey ${apiKey}`,
      "X-CatsCo-Bot-Id": botId,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

async function mutationRequest(body) {
  const response = await fetch(`${baseUrl}/api/internal/bot/private-skill-versions`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${mutationWriterSecret}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}
