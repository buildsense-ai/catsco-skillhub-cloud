import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  createApiServer,
  parsePrivateSkillHistoryRequest,
  parsePrivateSkillMetadataRequest,
  startApiServer
} from "../../apps/api/server.js";
import { RateLimiter } from "../../packages/auth/index.js";
import { authenticateCatsCoBot } from "../../packages/bot-auth/index.js";
import { loadConfig } from "../../packages/config/index.js";
import { hasBlockingFindings, sha256 } from "../../packages/domain/index.js";
import {
  buildPrivatePackage,
  computePrivateSkillContentHash,
  isPrivateSkillReference,
  parsePrivateSkillUpsert,
  publicVersionAsDownloadedPackage,
  readPrivatePackage,
  writePrivatePackageAtomic
} from "../../packages/private-skills/index.js";
import {
  buildPublishedPackage,
  computeSkillContentHash
} from "../../packages/packager/index.js";
import {
  canonicalJson,
  ensureSigningKey,
  issueSigningKeyCertificate,
  listActiveSigningKeyCertificates,
  loadSigningKeyCertificateByKeyId,
  signPayload
} from "../../packages/signing/index.js";
import { scanSkillPackage } from "../../packages/scanner/index.js";

const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

test("private reference detection covers current and legacy namespaces", () => {
  assert.equal(isPrivateSkillReference("legacy-author/legacy-skill"), false);
  assert.equal(isPrivateSkillReference(`priv_${"a".repeat(40)}`), true);
  assert.equal(isPrivateSkillReference("priv_malformed"), true);
  assert.equal(isPrivateSkillReference("PRIVATE/legacy-reference"), true);
});

test("private upload rate defaults support full Agent synchronization and remain configurable", () => {
  assert.equal(testConfig("unused").privateSkills.maxUploadsPerMinute, 300);
  assert.equal(testConfig("unused", undefined, {
    privateSkillMaxUploadsPerMinute: 42
  }).privateSkills.maxUploadsPerMinute, 42);
});

test("rate limiter refunds idempotent work without opening additional capacity", () => {
  const limiter = new RateLimiter({ limit: 2 });
  assert.equal(limiter.check("bot"), true);
  limiter.refund("bot");
  assert.equal(limiter.check("bot"), true);
  assert.equal(limiter.check("bot"), true);
  assert.equal(limiter.check("bot"), false);
});

test("private metadata request validation is bounded, private-only, and deduplicated", () => {
  const first = { skillId: `priv_${"a".repeat(40)}`, version: "v_1" };
  assert.deepEqual(parsePrivateSkillMetadataRequest({ references: [first, first] }), [first]);
  assert.throws(
    () => parsePrivateSkillMetadataRequest({ references: [{ skillId: "lin/public", version: "1.0.0" }] }),
    (error) => error.code === "PRIVATE_SKILL_METADATA_REFERENCE_INVALID" && error.status === 400
  );
  assert.throws(
    () => parsePrivateSkillMetadataRequest({ references: Array.from({ length: 1025 }, () => first) }),
    (error) => error.code === "PRIVATE_SKILL_METADATA_REFERENCES_INVALID" && error.status === 400
  );
  assert.deepEqual(
    parsePrivateSkillMetadataRequest({
      references: Array.from({ length: 1024 }, (_value, index) => ({
        skillId: `priv_${String(index).padStart(40, "0")}`,
        version: `v_${index}`
      }))
    }).length,
    1024
  );
});

test("private history request validation is private-only and cursor bounded", () => {
  const skillId = `priv_${"a".repeat(40)}`;
  assert.deepEqual(parsePrivateSkillHistoryRequest({ skillId }), {
    skillId,
    limit: 50,
    beforeRevisionNumber: null
  });
  assert.deepEqual(parsePrivateSkillHistoryRequest({
    skillId,
    limit: 100,
    beforeRevisionNumber: 17
  }), {
    skillId,
    limit: 100,
    beforeRevisionNumber: 17
  });
  assert.throws(
    () => parsePrivateSkillHistoryRequest({ skillId: "lin/public" }),
    (error) => error.code === "PRIVATE_SKILL_HISTORY_REFERENCE_INVALID" && error.status === 400
  );
  for (const limit of [0, 101, 1.5, "10"]) {
    assert.throws(
      () => parsePrivateSkillHistoryRequest({ skillId, limit }),
      (error) => error.code === "PRIVATE_SKILL_HISTORY_LIMIT_INVALID" && error.status === 400
    );
  }
  for (const beforeRevisionNumber of [0, 1.5, "2", 1_000_000_001]) {
    assert.throws(
      () => parsePrivateSkillHistoryRequest({ skillId, beforeRevisionNumber }),
      (error) => error.code === "PRIVATE_SKILL_HISTORY_CURSOR_INVALID" && error.status === 400
    );
  }
});

test("private metadata route accepts the maximum validated reference request", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== "ApiKey valid-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  const references = Array.from({ length: 1024 }, (_, index) => {
    const skillPrefix = `priv_${index.toString(16).padStart(4, "0")}_`;
    const versionPrefix = `v_${index.toString(16).padStart(4, "0")}_`;
    return {
      skillId: `${skillPrefix}${"界".repeat(240 - skillPrefix.length)}`,
      version: `${versionPrefix}${"版".repeat(120 - versionPrefix.length)}`
    };
  });
  const requestBody = JSON.stringify({ references });
  assert.ok(Buffer.byteLength(requestBody) > 1024 * 1024);

  let receivedReferences;
  const server = createApiServer(
    testConfig("unused", `http://127.0.0.1:${upstreamAddress.port}`),
    {
      store: {
        async findPrivateSkillMetadata(input) {
          receivedReferences = input.references;
          return [];
        }
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-metadata`, {
    method: "POST",
    headers: {
      authorization: "ApiKey valid-key",
      "content-type": "application/json",
      "x-catsco-bot-id": "42"
    },
    body: requestBody
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { skills: [] });
  assert.equal(receivedReferences.length, 1024);

  const escapedReferences = Array.from({ length: 1024 }, (_, index) => {
    const skillPrefix = `priv_${index.toString(16).padStart(4, "0")}_`;
    const versionPrefix = `v_${index.toString(16).padStart(4, "0")}_`;
    return {
      skillId: `${skillPrefix}${"\ud800".repeat(240 - skillPrefix.length)}`,
      version: `${versionPrefix}${"\ud800".repeat(120 - versionPrefix.length)}`
    };
  });
  const escapedRequestBody = JSON.stringify({ references: escapedReferences });
  assert.ok(Buffer.byteLength(escapedRequestBody) > 2 * 1024 * 1024);
  const escapedResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/bot/private-skill-metadata`,
    {
      method: "POST",
      headers: {
        authorization: "ApiKey valid-key",
        "content-type": "application/json",
        "x-catsco-bot-id": "42"
      },
      body: escapedRequestBody
    }
  );
  assert.equal(escapedResponse.status, 400);
  assert.equal((await escapedResponse.json()).error.code, "PRIVATE_SKILL_REFERENCE_INVALID");
});

test("private metadata exposes only readable revision and change attribution fields", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  const reference = { skillId: `priv_${"a".repeat(40)}`, version: `v_${"b".repeat(48)}` };
  const server = createApiServer(
    testConfig("unused", `http://127.0.0.1:${upstreamAddress.port}`),
    {
      store: {
        async findPrivateSkillMetadata() {
          return [{
            ...reference,
            name: "review-helper",
            revisionNumber: 3,
            hasConversationMutation: true,
            lastChangedAt: "2026-08-22T05:06:07.000Z",
            activatedAt: "2026-08-22T02:03:04.000Z",
            contentHash: "c".repeat(64),
            packagePath: "/private/secret.json",
            gitCommitSha: "d".repeat(40)
          }];
        }
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-metadata`, {
    method: "POST",
    headers: {
      authorization: "ApiKey valid-key",
      "content-type": "application/json",
      "x-catsco-bot-id": "42"
    },
    body: JSON.stringify({ references: [reference] })
  });

  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.deepEqual(responseBody, {
    skills: [{
      source: "skillhub",
      ...reference,
      displayName: "review-helper",
      revisionNumber: 3,
      changeSource: "conversation_mutation",
      lastChangedAt: "2026-08-22T05:06:07.000Z"
    }]
  });
  assert.equal(JSON.stringify(responseBody).includes("UserUid"), false);
});

test("private history route is Bot-scoped and exposes only read-only metadata", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  const authority = `http://127.0.0.1:${upstreamAddress.port}`;
  const skillId = `priv_${"a".repeat(40)}`;
  let receivedInput;
  const server = createApiServer(
    testConfig("unused", authority),
    {
      store: {
        async listPrivateSkillHistory(input) {
          receivedInput = input;
          return {
            versions: [{
              skillId,
              version: `v_${"b".repeat(48)}`,
              name: "review-helper",
              revisionNumber: 3,
              hasConversationMutation: true,
              lastChangedAt: "2026-08-22T05:06:07.000Z",
              activatedAt: "2026-08-22T02:03:04.000Z",
              contentHash: "c".repeat(64),
              packagePath: "/private/secret.json",
              gitCommitSha: "d".repeat(40),
              actorUserUid: 7
            }],
            nextBeforeRevisionNumber: 3
          };
        }
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-history`, {
    method: "POST",
    headers: {
      authorization: "ApiKey valid-key",
      "content-type": "application/json",
      "x-catsco-bot-id": "42"
    },
    body: JSON.stringify({ skillId, limit: 20, beforeRevisionNumber: 9 })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedInput, {
    authority,
    ownerBotId: "42",
    skillId,
    limit: 20,
    beforeRevisionNumber: 9
  });
  const responseBody = await response.json();
  assert.deepEqual(responseBody, {
    skillId,
    versions: [{
      source: "skillhub",
      skillId,
      version: `v_${"b".repeat(48)}`,
      displayName: "review-helper",
      revisionNumber: 3,
      changeSource: "conversation_mutation",
      lastChangedAt: "2026-08-22T05:06:07.000Z"
    }],
    nextBeforeRevisionNumber: 3
  });
  for (const forbidden of ["contentHash", "packagePath", "gitCommitSha", "actorUserUid"]) {
    assert.equal(JSON.stringify(responseBody).includes(forbidden), false);
  }
});

test("private history has an independent kill switch from runtime reads", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  const server = createApiServer(testConfig("unused", `http://127.0.0.1:${upstreamAddress.port}`, {
    privateSkillsReadEnabled: true,
    privateSkillHistoryEnabled: false
  }), {
    store: {
      async findPrivateSkillMetadata() {
        return [];
      },
      async listPrivateSkillHistory() {
        assert.fail("disabled history must not reach storage");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-history`, {
    method: "POST",
    headers: {
      authorization: "ApiKey unused",
      "content-type": "application/json",
      "x-catsco-bot-id": "42"
    },
    body: JSON.stringify({ skillId: `priv_${"a".repeat(40)}` })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "PRIVATE_SKILL_HISTORY_DISABLED");

  const metadata = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-metadata`, {
    method: "POST",
    headers: {
      authorization: "ApiKey valid-key",
      "content-type": "application/json",
      "x-catsco-bot-id": "42"
    },
    body: JSON.stringify({ references: [] })
  });
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), { skills: [] });
});

test("private history rate limits cannot consume runtime metadata read capacity", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  const server = createApiServer(testConfig("unused", `http://127.0.0.1:${upstreamAddress.port}`), {
    store: {
      async findPrivateSkillMetadata() {
        return [];
      },
      async listPrivateSkillHistory() {
        return { versions: [], nextBeforeRevisionNumber: null };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const headers = {
    authorization: "ApiKey valid-key",
    "content-type": "application/json",
    "x-catsco-bot-id": "42"
  };
  let lastHistory;
  for (let index = 0; index < 121; index += 1) {
    lastHistory = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-history`, {
      method: "POST",
      headers,
      body: JSON.stringify({ skillId: `priv_${"a".repeat(40)}` })
    });
  }
  assert.equal(lastHistory.status, 429);
  assert.equal((await lastHistory.json()).error.code, "PRIVATE_SKILL_HISTORY_RATE_LIMITED");

  const metadata = await fetch(`http://127.0.0.1:${address.port}/api/bot/private-skill-metadata`, {
    method: "POST",
    headers,
    body: JSON.stringify({ references: [] })
  });
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), { skills: [] });
});

test("private package validation uses canonical ordering and supports zero-byte files", () => {
  const files = [
    file("z.txt", Buffer.alloc(0)),
    file("SKILL.md", Buffer.from("# Test\n"))
  ];
  const contentHash = computePrivateSkillContentHash(files);
  const config = testConfig("unused");
  const parsed = parsePrivateSkillUpsert({
    localSkillId: "local-a",
    name: "alpha",
    contentHash,
    files
  }, config);

  assert.deepEqual(parsed.files.map((item) => item.path), ["SKILL.md", "z.txt"]);
  assert.equal(parsed.totalBytes, Buffer.byteLength("# Test\n"));
  assert.equal(parsed.contentHash, contentHash);
});

test("private package validation rejects unsafe paths and tampered bytes", () => {
  const config = testConfig("unused");
  const base = {
    localSkillId: "local-a",
    name: "alpha",
    contentHash: "a".repeat(64)
  };
  assert.throws(
    () => parsePrivateSkillUpsert({
      ...base,
      files: [file("../SKILL.md", Buffer.from("# bad\n"))]
    }, config),
    (error) => error.code === "path.traversal"
  );
  assert.throws(
    () => parsePrivateSkillUpsert({
      ...base,
      files: [{
        ...file("SKILL.md", Buffer.from("# bad\n")),
        sha256: "b".repeat(64)
      }]
    }, config),
    (error) => error.code === "PRIVATE_SKILL_FILE_HASH_MISMATCH"
  );
});

test("private package validation keeps package structure and transport boundaries", () => {
  const config = testConfig("unused");
  const skill = file("SKILL.md", Buffer.from("# Test\n"));
  const parse = (files, contentHash = computePrivateSkillContentHash(files)) => (
    parsePrivateSkillUpsert({
      localSkillId: "local-a",
      name: "alpha",
      contentHash,
      files
    }, config)
  );

  assert.throws(
    () => parse([file("C:/SKILL.md", Buffer.from("# bad\n"))]),
    (error) => error.code === "path.absolute_or_windows"
  );
  assert.throws(
    () => parse([skill, { ...skill, path: "skill.md" }]),
    (error) => error.code === "PRIVATE_SKILL_DUPLICATE_PATH"
  );
  assert.throws(
    () => parse([{
      ...skill,
      contentBase64: "not-canonical-base64"
    }]),
    (error) => error.code === "PRIVATE_SKILL_BASE64_INVALID"
  );
  assert.throws(
    () => parse([file("README.md", Buffer.from("missing entry\n"))]),
    (error) => error.code === "PRIVATE_SKILL_ENTRY_MISSING"
  );
  assert.throws(
    () => parse([skill], "f".repeat(64)),
    (error) => error.code === "PRIVATE_SKILL_CONTENT_HASH_MISMATCH"
  );
});

test("private package validation allows credentials, archives, and binary content", () => {
  const config = testConfig("unused");
  const contentFiles = [
    file("SKILL.md", Buffer.from("# Test\napi_key=sk-proj-1234567890abcdefghijklmnop\n")),
    file(".env", Buffer.from("AWS_SECRET_ACCESS_KEY=not-a-real-aws-secret-1234567890\n")),
    file(".ssh/id_rsa", Buffer.from("-----BEGIN PRIVATE KEY-----\nprivate material\n")),
    file("payload.zip", Buffer.from("plain text disguised by extension")),
    file("payload.bin", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])),
    file("runtime.exe", Buffer.from([0x4d, 0x5a, 0x00, 0x01]))
  ];

  assert.doesNotThrow(() => parsePrivateSkillUpsert({
    localSkillId: "local-a",
    name: "alpha",
    contentHash: computePrivateSkillContentHash(contentFiles),
    files: contentFiles
  }, config));
});

test("private package validation allows literal credential assignments", () => {
  const config = testConfig("unused");
  const assignments = [
    "CATSCO_API_KEY=not-a-real-catsco-key-1234567890",
    "AWS_SECRET_ACCESS_KEY=not-a-real-aws-secret-1234567890",
    "MY_SERVICE_TOKEN=not-a-real-service-token-1234567890",
    "{\"catscoApiKey\":\"not-a-real-json-key-1234567890\"}",
    "DJANGO_SECRET_KEY=django-insecure-abcdefghijklmnopqrstuvwxyz1234567890",
    "API_KEY=abcd1234",
    "password=S3cur3Pass!",
    "SAFE=${SAFE};PASSWORD=realpassword",
    "config[\"apiKey\"]=\"realpassword\"",
    "API_KEY?=realpassword",
    "API_KEY+=realpassword",
    "connect(api_key=\"realpassword\")",
    "API_KEY=\"${SAFE_ENV} actual-secret-value\"",
    "SAFE=x&&PASSWORD=realpassword",
    "SAFE=x&PASSWORD=realpassword",
    "https://x.test/?access_token=realpassword"
  ];

  for (const assignment of assignments) {
    const files = [file("SKILL.md", Buffer.from(`${assignment}\n`))];
    assert.doesNotThrow(() => parsePrivateSkillUpsert({
      localSkillId: "local-a",
      name: "alpha",
      contentHash: computePrivateSkillContentHash(files),
      files
    }, config));
  }
});

test("private package validation allows explicit safe references, placeholders, and schema values", () => {
  const config = testConfig("unused");
  const files = [file("SKILL.md", Buffer.from([
    "CATSCO_API_KEY=your_api_key_here",
    "MY_SERVICE_TOKEN=placeholder-value",
    "clientSecret=****************",
    "STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}",
    "password=minimum_length_16",
    "interface Config { apiKey: string; }",
    "{ password: z.string().min(8) }",
    "clientSecret: null",
    "API_KEY=\"\""
  ].join("\n")))];

  assert.doesNotThrow(() => parsePrivateSkillUpsert({
    localSkillId: "local-a",
    name: "alpha",
    contentHash: computePrivateSkillContentHash(files),
    files
  }, config));
});

test("private Bot backups allow runtime capabilities without weakening public publication scanning", () => {
  const config = testConfig("unused");
  const skillMarkdown = Buffer.from("# Runtime Skill\n");
  const runtimeScript = Buffer.from([
    'import { spawn } from "node:child_process";',
    "const apiKey = process.env.OPENAI_API_KEY;",
    "const token = process.env.CATSCO_TOKEN ?? void 0;",
    'const optionalToken = process.env.CATSCO_TOKEN ?? "";',
    'await fetch("https://api.example.com/status");',
    'spawn("git", ["status"]);',
    ""
  ].join("\n"));
  const pythonScript = Buffer.from([
    'api_key = os.environ.get("OPENAI_API_KEY", "")',
    'auth_token = os.environ.get(args.api_key_env, "")  # optional',
    ""
  ].join("\n"));
  const files = [
    file("SKILL.md", skillMarkdown),
    file("scripts/runtime.mjs", runtimeScript),
    file("scripts/runtime.py", pythonScript)
  ];

  assert.doesNotThrow(() => parsePrivateSkillUpsert({
    localSkillId: "local-runtime",
    name: "runtime-skill",
    contentHash: computePrivateSkillContentHash(files),
    files
  }, config));

  const publicReport = scanSkillPackage({
    files: [
      { path: "SKILL.md", buffer: skillMarkdown },
      { path: "scripts/runtime.mjs", buffer: runtimeScript },
      { path: "scripts/runtime.py", buffer: pythonScript }
    ],
    manifest: {
      entrypoints: { skillFile: "SKILL.md" },
      permissions: { filesystem: "none", network: "none", shell: "none", secrets: "none" }
    },
    config
  });
  assert.equal(publicReport.status, "passed");
  assert.equal(hasBlockingFindings(publicReport.findings), true);
});

test("private Bot backups allow literal and shadowed runtime credential fallbacks", () => {
  const config = testConfig("unused");
  const unsafeScripts = [
    'const token = process.env.CATSCO_TOKEN ?? "a-real-secret-value-that-must-not-leave-device";',
    [
      'const undefined = "a-real-secret-value-that-must-not-leave-device";',
      "const token = process.env.CATSCO_TOKEN ?? undefined;"
    ].join("\n"),
    [
      'function run(undefined = "a-real-secret-value-that-must-not-leave-device") {',
      "  const token = process.env.CATSCO_TOKEN ?? undefined;",
      "}"
    ].join("\n")
  ];

  for (const source of unsafeScripts) {
    const files = [
      file("SKILL.md", Buffer.from("# Unsafe\n")),
      file("runtime.mjs", Buffer.from(`${source}\n`))
    ];
    assert.doesNotThrow(() => parsePrivateSkillUpsert({
      localSkillId: "local-unsafe",
      name: "unsafe",
      contentHash: computePrivateSkillContentHash(files),
      files
    }, config));
  }
});

test("private package validation accepts credential-like content with long whitespace tails", () => {
  const config = testConfig("unused");
  const bytes = Buffer.from(`API_TOKEN=\${API_TOKEN}\n${" ".repeat(64 * 1024)}`);
  const files = [file("SKILL.md", bytes)];
  const startedAt = Date.now();

  assert.doesNotThrow(() => parsePrivateSkillUpsert({
    localSkillId: "local-whitespace",
    name: "whitespace",
    contentHash: computePrivateSkillContentHash(files),
    files
  }, config));
  assert.ok(Date.now() - startedAt < 1_000, "package validation exceeded its bounded runtime budget");
});

test("private package validation allows password policy values for arbitrary secret keys", () => {
  const config = testConfig("unused");
  const files = [file("SKILL.md", Buffer.from("STRIPE_SECRET_KEY=minimum_length_16\n"))];
  assert.doesNotThrow(() => parsePrivateSkillUpsert({
    localSkillId: "local-a",
    name: "alpha",
    contentHash: computePrivateSkillContentHash(files),
    files
  }, config));
});

test("private package storage is immutable and verifies bytes again on read", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-private-unit-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const rawFiles = [file("SKILL.md", Buffer.from("# Test\n"))];
  const input = parsePrivateSkillUpsert({
    localSkillId: "local-a",
    name: "alpha",
    contentHash: computePrivateSkillContentHash(rawFiles),
    files: rawFiles
  }, config);
  const reservation = {
    id: "pv_test",
    skillId: `priv_${"a".repeat(40)}`,
    version: `v_${"b".repeat(48)}`,
    createdAt: "2026-07-24T00:00:00.000Z"
  };
  const packageValue = buildPrivatePackage({ reservation, input });
  const stored = await writePrivatePackageAtomic(config, packageValue);
  const row = {
    ...reservation,
    localSkillId: input.localSkillId,
    contentHash: input.contentHash,
    packagePath: stored.packagePath,
    packageSha256: stored.packageSha256
  };
  assert.deepEqual(await readPrivatePackage(row, config), packageValue);

  await fs.appendFile(stored.packagePath, "tampered");
  await assert.rejects(
    readPrivatePackage(row, config),
    (error) => error.code === "PRIVATE_SKILL_STORED_PACKAGE_TAMPERED"
  );
});

test("published package conversion produces the same normalized workspace hash contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-public-unit-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, "published.skillpkg");
  const files = [file("SKILL.md", Buffer.from("# Public\r\n"))];
  const config = testConfig(root);
  await issueSigningKeyCertificate(config);
  const signingKey = await ensureSigningKey(config);
  const payload = {
    manifest: {
      id: "lin/agent-browser",
      name: "agent-browser",
      version: "1.2.3"
    },
    files
  };
  const packageBytes = Buffer.from(canonicalJson({
    payload,
    signature: signPayload(payload, signingKey),
    checksum: { payloadSha256: sha256(canonicalJson(payload)) }
  }));
  await fs.writeFile(packagePath, packageBytes);
  const normalizedFiles = [file("SKILL.md", Buffer.from("# Public\n"))];
  const contentHash = computePrivateSkillContentHash(normalizedFiles);
  const downloaded = await publicVersionAsDownloadedPackage({
    skillId: "lin/agent-browser",
    skillName: "agent-browser",
    version: "1.2.3",
    packagePath,
    checksumSha256: sha256(packageBytes),
    contentHash,
    publishedAt: "2026-07-24T00:00:00.000Z"
  }, config);
  assert.deepEqual(downloaded.reference, { skillId: "lin/agent-browser", version: "1.2.3" });
  assert.equal(downloaded.files[0].contentBase64, normalizedFiles[0].contentBase64);
  assert.equal(downloaded.contentHash, contentHash);
  assert.match(downloaded.localSkillId, /^public-[a-f0-9]{32}$/);

  await assert.rejects(
    publicVersionAsDownloadedPackage({
      skillId: "lin/agent-browser",
      skillName: "agent-browser",
      version: "1.2.3",
      packagePath,
      checksumSha256: sha256(packageBytes),
      contentHash: "f".repeat(64),
      publishedAt: "2026-07-24T00:00:00.000Z"
    }, config),
    (error) => error.code === "PUBLIC_SKILL_PACKAGE_TAMPERED"
  );

  await assert.rejects(
    publicVersionAsDownloadedPackage({
      skillId: "lin/agent-browser",
      skillName: "agent-browser",
      version: "1.2.3",
      packagePath,
      checksumSha256: sha256(packageBytes),
      publishedAt: "2026-07-24T00:00:00.000Z"
    }, config),
    (error) => error.code === "PUBLIC_SKILL_PACKAGE_TAMPERED"
  );
});

test("published package stores normalized bytes and deterministic file ordering", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-packager-unit-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const config = testConfig(root);
  await issueSigningKeyCertificate(config);
  const rawFiles = [
    { path: "subdir/SKILL.md", buffer: Buffer.from("nested\r\n") },
    { path: "_meta.txt", buffer: Buffer.from("meta\r\n") },
    { path: "SKILL.md", buffer: Buffer.from("# Root\r\n") },
    { path: "notes.txt", buffer: Buffer.from("notes\r\n") }
  ];
  const published = await buildPublishedPackage({
    config,
    submission: {
      id: "sub_packager_test",
      normalizedManifest: {
        id: "lin/packager-test",
        name: "packager-test",
        displayName: "Packager Test",
        version: "1.0.0"
      }
    },
    files: rawFiles,
    scanRun: { id: "scan_packager_test", riskLevel: "low" },
    reviewer: { id: "reviewer_packager_test" },
    sourceVersion: {
      repositoryId: "git_packager_test",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      tag: "v1.0.0"
    },
    releaseAt: "2026-08-04T00:00:00.000Z"
  });
  const packageObject = JSON.parse(await fs.readFile(published.packagePath, "utf8"));
  const packagedFiles = packageObject.payload.files;

  assert.deepEqual(
    packagedFiles.map((item) => item.path),
    ["SKILL.md", "_meta.txt", "notes.txt", "subdir/SKILL.md"]
  );
  assert.equal(
    Buffer.from(packagedFiles[0].contentBase64, "base64").toString("utf8"),
    "# Root\n"
  );
  assert.equal(
    Buffer.from(packagedFiles[1].contentBase64, "base64").toString("utf8"),
    "meta\r\n"
  );
  assert.equal(
    Buffer.from(packagedFiles[3].contentBase64, "base64").toString("utf8"),
    "nested\r\n"
  );
  for (const packagedFile of packagedFiles) {
    const bytes = Buffer.from(packagedFile.contentBase64, "base64");
    assert.equal(packagedFile.size, bytes.length);
    assert.equal(packagedFile.sha256, sha256(bytes));
  }
  assert.equal(published.contentHash, computeSkillContentHash(rawFiles));
  assert.equal(published.contentHash, computePrivateSkillContentHash(packagedFiles));
});

test("published package bridge rejects unsigned packages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-public-unsigned-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, "unsigned.skillpkg");
  const bytes = Buffer.from(JSON.stringify({
    payload: {
      manifest: { id: "lin/unsigned", name: "unsigned", version: "1.0.0" },
      files: [file("SKILL.md", Buffer.from("# Unsigned\n"))]
    }
  }));
  await fs.writeFile(packagePath, bytes);
  await assert.rejects(
    publicVersionAsDownloadedPackage({
      skillId: "lin/unsigned",
      skillName: "unsigned",
      version: "1.0.0",
      packagePath,
      checksumSha256: sha256(bytes),
      publishedAt: "2026-07-24T00:00:00.000Z"
    }, testConfig(root)),
    (error) => error.code === "PUBLIC_SKILL_PACKAGE_UNTRUSTED"
  );
});

test("published package bridge keeps old packages recoverable after signing key rotation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-public-rotation-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const configA = signingConfig(root, "signing-a");
  await issueSigningKeyCertificate(configA);
  const fixtureA = await publishedFixture(root, configA, {
    skillId: "lin/rotation-a",
    name: "rotation-a",
    version: "1.0.0"
  });
  await fs.rm(configA.signing.certificateArchiveDir, { recursive: true, force: true });

  const configB = signingConfig(root, "signing-b");
  await issueSigningKeyCertificate(configB);
  assert.deepEqual(
    (await listActiveSigningKeyCertificates(configB)).map(item => item.subject.keyId),
    ["signing-a", "signing-b"]
  );
  const fixtureB = await publishedFixture(root, configB, {
    skillId: "lin/rotation-b",
    name: "rotation-b",
    version: "2.0.0"
  });

  const [restoredA, restoredB] = await Promise.all([
    publicVersionAsDownloadedPackage(fixtureA.row, configB),
    publicVersionAsDownloadedPackage(fixtureB.row, configB)
  ]);
  assert.deepEqual(restoredA.reference, { skillId: "lin/rotation-a", version: "1.0.0" });
  assert.deepEqual(restoredB.reference, { skillId: "lin/rotation-b", version: "2.0.0" });

  await fs.rm(configB.signing.certificateArchiveDir, { recursive: true, force: true });
  await assert.rejects(
    publicVersionAsDownloadedPackage(fixtureA.row, configB),
    (error) => error.code === "PUBLIC_SKILL_PACKAGE_UNTRUSTED"
  );
});

test("historical signing certificate lookup rejects unsafe ids and expired certificates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-public-certificate-safety-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const expired = signingConfig(root, "signing-expired", "2020-01-01T00:00:00.000Z");
  await assert.rejects(
    issueSigningKeyCertificate(expired),
    /validity window is invalid/
  );
  await assert.rejects(
    loadSigningKeyCertificateByKeyId(expired, "../signing-expired"),
    /keyId is invalid/
  );

  const renewed = signingConfig(root, "signing-expired", "2030-01-01T00:00:00.000Z", {
    certificatePath: path.join(root, "shared", "keys", "renewed-signing-certificate.json")
  });
  await issueSigningKeyCertificate(renewed);
  const certificate = await loadSigningKeyCertificateByKeyId(renewed, "signing-expired");
  assert.equal(certificate.subject.keyId, "signing-expired");
  assert.equal(certificate.expiresAt, "2030-01-01T00:00:00.000Z");

  const conflicting = signingConfig(root, "signing-expired", "2031-01-01T00:00:00.000Z", {
    certificatePath: path.join(root, "shared", "keys", "conflicting-signing-certificate.json"),
    keySuffix: "conflict"
  });
  await assert.rejects(
    issueSigningKeyCertificate(conflicting),
    /already belongs to another public key/
  );
});

test("concurrent certificate issuance atomically binds one public key to each keyId", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-certificate-binding-race-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const bootstrap = signingConfig(root, "bootstrap-root");
  await issueSigningKeyCertificate(bootstrap);
  const first = signingConfig(root, "signing-race", "2030-01-01T00:00:00.000Z", {
    certificatePath: path.join(root, "shared", "keys", "race-first-certificate.json"),
    keySuffix: "race-first"
  });
  const second = signingConfig(root, "signing-race", "2030-01-01T00:00:00.000Z", {
    certificatePath: path.join(root, "shared", "keys", "race-second-certificate.json"),
    keySuffix: "race-second"
  });

  const results = await Promise.allSettled([
    issueSigningKeyCertificate(first),
    issueSigningKeyCertificate(second)
  ]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.filter(item => item.status === "rejected").length, 1);
  assert.match(
    String(results.find(item => item.status === "rejected")?.reason?.message),
    /already belongs to another public key/
  );
});

test("CatsCo Bot authentication derives and binds the real Bot id", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== "ApiKey valid-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uid: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const config = testConfig("unused", `http://127.0.0.1:${address.port}`);

  const identity = await authenticateCatsCoBot(config, request("valid-key", "42"));
  assert.equal(identity.botId, "42");
  await assert.rejects(
    authenticateCatsCoBot(config, request("valid-key", "43")),
    (error) => error.code === "BOT_BINDING_MISMATCH" && error.status === 403
  );
  await assert.rejects(
    authenticateCatsCoBot(config, request("invalid-key", "42")),
    (error) => error.code === "BOT_AUTH_INVALID" && error.status === 401
  );
});

test("production startup rejects unsafe private Skill rollout settings", async () => {
  const base = {
    root: "unused",
    databaseUrl: "postgresql://unused",
    sessionSecret: "x".repeat(64),
    nodeEnv: "production",
    catsCoBaseUrl: "https://app.catsco.cc"
  };
  await assert.rejects(
    startApiServer(loadConfig({
      ...base,
      privateSkillsReadEnabled: false,
      privateSkillsWriteEnabled: true,
      privateSkillAllowedBotIds: ["42"]
    })),
    /writes require private Skill reads/i
  );
  await assert.rejects(
    startApiServer(loadConfig({
      ...base,
      privateSkillsReadEnabled: true,
      privateSkillsWriteEnabled: false,
      privateSkillAllowedBotIds: [],
      privateSkillAllowAllBots: false
    })),
    /requires a Bot allowlist/i
  );
  await assert.rejects(
    startApiServer(loadConfig({
      ...base,
      privateSkillsReadEnabled: true,
      privateSkillsWriteEnabled: false,
      privateSkillAllowedBotIds: ["42"],
      privateSkillMaxFiles: 201
    })),
    /outside the supported production safety boundary/i
  );
  await assert.rejects(
    startApiServer(loadConfig({
      ...base,
      privateSkillsReadEnabled: true,
      privateSkillsWriteEnabled: false,
      privateSkillAllowedBotIds: ["42"],
      privateSkillMaxUploadsPerMinute: 601
    })),
    /outside the supported production safety boundary/i
  );
});

function file(filePath, bytes) {
  return {
    path: filePath,
    size: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64")
  };
}

function testConfig(root, catsCoBaseUrl = "http://127.0.0.1:1", overrides = {}) {
  return loadConfig({
    root,
    storageRoot: path.join(root, "storage"),
    logsRoot: path.join(root, "logs"),
    sharedRoot: path.join(root, "shared"),
    catsCoBaseUrl,
    nodeEnv: "test",
    ...overrides
  });
}

function signingConfig(root, keyId, expiresAt = "2030-01-01T00:00:00.000Z", options = {}) {
  const keySuffix = options.keySuffix ?? keyId;
  return loadConfig({
    root,
    storageRoot: path.join(root, "storage"),
    logsRoot: path.join(root, "logs"),
    sharedRoot: path.join(root, "shared"),
    signingKeyId: keyId,
    signingPrivateKeyPath: path.join(root, "shared", "keys", `${keySuffix}-private.pem`),
    signingPublicKeyPath: path.join(root, "shared", "keys", `${keySuffix}-public.pem`),
    signingCertificatePath:
      options.certificatePath ?? path.join(root, "shared", "keys", "current-signing-certificate.json"),
    signingCertificateArchiveDir: path.join(root, "shared", "keys", "signing-certificates"),
    signingCertificateExpiresAt: expiresAt,
    rootKeyId: "test-root",
    rootPrivateKeyPath: path.join(root, "shared", "keys", "test-root-private.pem"),
    rootPublicKeyPath: path.join(root, "shared", "keys", "test-root-public.pem"),
    allowAutoKeygen: true,
    allowAutoRootKeygen: true,
    nodeEnv: "test"
  });
}

async function publishedFixture(root, config, { skillId, name, version }) {
  const packagePath = path.join(root, `${name}-${version}.skillpkg`);
  const files = [file("SKILL.md", Buffer.from(`# ${name}\n`))];
  const signingKey = await ensureSigningKey(config);
  const payload = {
    manifest: { id: skillId, name, version },
    files
  };
  const packageBytes = Buffer.from(canonicalJson({
    payload,
    signature: signPayload(payload, signingKey),
    checksum: { payloadSha256: sha256(canonicalJson(payload)) }
  }));
  await fs.writeFile(packagePath, packageBytes);
  return {
    row: {
      skillId,
      skillName: name,
      version,
      packagePath,
      checksumSha256: sha256(packageBytes),
      contentHash: computePrivateSkillContentHash(files),
      publishedAt: "2026-07-24T00:00:00.000Z"
    }
  };
}

function request(apiKey, botId) {
  return {
    headers: {
      authorization: `ApiKey ${apiKey}`,
      "x-catsco-bot-id": botId
    }
  };
}
