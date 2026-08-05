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
const suffix = `${Date.now().toString(36)}-${process.pid}`;
let root;
let upstream;
let server;
let baseUrl;

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
  const config = loadConfig({
    root,
    storageRoot: path.join(root, "storage"),
    logsRoot: path.join(root, "logs"),
    sharedRoot: path.join(root, "shared"),
    databaseUrl,
    sessionSecret: "test-session-secret-that-is-long-enough-for-tests",
    catsCoBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    privateSkillMaxConcurrentUploads: 16,
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

  const oldStillExists = await request("GET", packagePath(first.reference), "bot-key-a", "42001");
  assert.equal(oldStillExists.status, 200);
  assert.equal(oldStillExists.data.contentHash, firstBody.contentHash);
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
  const response = await fetch(`${baseUrl}${pathname}`, {
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
