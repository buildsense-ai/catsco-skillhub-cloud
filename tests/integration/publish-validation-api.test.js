import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { runPublishValidation } from "../../packages/publish-validation/runner.js";
import { hashSessionToken } from "../../packages/auth/index.js";

const endpoint = "/api/skills/publish-validation";
const headers = { Authorization: "Bearer preflight-test-secret", "Content-Type": "application/json" };
// WHATWG Fetch bad ports. Local machines may configure ephemeral ranges below
// 10080, so rejecting every low port would incorrectly exhaust all retries.
const fetchBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);
const valid = JSON.stringify({ source: { type: "files", files: [
  { path: "SKILL.md", content: "---\nname: validation-example\ndescription: A useful validation example.\n---\n# Example\n" }
] } });

async function withServer(overrides, callback, storeOverride) {
  // Any unplanned storage access fails: preflight must not write, enqueue, sign,
  // fetch a package or call any model. Agent authentication needs no store call.
  const store = storeOverride ?? new Proxy({}, { get(_target, name) { throw new Error(`Unexpected store access: ${String(name)}`); } });
  const server = createApiServer(loadConfig({ nodeEnv: "test", publishValidationEnabled: true,
    agentClientSecret: "preflight-test-secret", ...overrides }), { store });
  // Some Windows ephemeral-port configurations include fetch-forbidden ports
  // (e.g. 6667). Rebind the test listener, never alter the client's port policy.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    if (!fetchBlockedPorts.has(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
  }
  assert.ok(server.listening, "Could not allocate a fetch-safe ephemeral port");
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await callback(base); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("preflight is disabled by default, including production", async () => {
  assert.equal(loadConfig({ nodeEnv: "production", publishValidationEnabled: false }).publishValidation.enabled, false);
  await withServer({ publishValidationEnabled: false }, async base => {
    const res = await fetch(base + endpoint, { method: "POST", headers, body: valid });
    assert.equal(res.status, 404);
  });
});

test("preflight authenticates before parsing untrusted content and describes effective limits", async () => {
  await withServer({}, async base => {
    const unauth = await fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "invalid JSON" });
    assert.equal(unauth.status, 401);
    const rules = await fetch(base + endpoint + "/rules", { headers });
    assert.equal(rules.status, 200);
    assert.equal(rules.headers.get("cache-control"), "no-store");
    const body = await rules.json();
    assert.equal(body.capabilities.preflight, true);
    assert.equal(body.capabilities.automaticRepair, false);
    assert.equal(body.limits.maxRequestBytes, 75 * 1024 * 1024);
  });
});

test("preflight distinguishes passed, package rejection, malformed request and request budget", async () => {
  await withServer({ publishValidationMaxRequestBytes: 4096 }, async base => {
    const passed = await fetch(base + endpoint, { method: "POST", headers, body: valid });
    assert.equal(passed.status, 200);
    assert.equal((await passed.json()).validation.outcome, "passed");
    const rejected = await fetch(base + endpoint, { method: "POST", headers, body: JSON.stringify({ source: { type: "files", files: [
      { path: "SKILL.md", content: "---\nname: example\n---\nContent" }
    ] } }) });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.validation.outcome, "rejected");
    const malformed = await fetch(base + endpoint, { method: "POST", headers, body: "{" });
    assert.equal(malformed.status, 400);
    const tooLarge = await fetch(base + endpoint, { method: "POST", headers, body: " ".repeat(4097) });
    assert.equal(tooLarge.status, 413);
    const utf8 = await fetch(base + endpoint, { method: "POST", headers, body: Buffer.from([0xff]) });
    assert.equal(utf8.status, 400);
  });
});

test("preflight enforces actor rate limits", async () => {
  await withServer({ publishValidationRequestsPerMinute: 1 }, async base => {
    assert.equal((await fetch(base + endpoint + "/rules", { headers })).status, 200);
    assert.equal((await fetch(base + endpoint, { method: "POST", headers, body: valid })).status, 429);
  });
});

test("preflight bounds slow/chunked reads and releases capacity", async () => {
  await withServer({ publishValidationMaxConcurrent: 1, publishValidationReadTimeoutMs: 200 }, async base => {
    let first;
    const response = new Promise((resolve, reject) => {
      first = http.request(base + endpoint, { method: "POST", headers }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      first.on("error", reject);
      first.write("{");
    });
    // Observe the held admission slot without relying on a fixed startup sleep.
    let status;
    for (let count = 0; count < 10 && status !== 503; count += 1) {
      status = (await fetch(base + endpoint + "/rules", { headers })).status;
    }
    assert.equal(status, 503);
    assert.equal(await response, 503);
    first.destroy();
    assert.equal((await fetch(base + endpoint + "/rules", { headers })).status, 200);
  });
});

test("chunked byte budgets apply without Content-Length", async () => {
  await withServer({ publishValidationMaxRequestBytes: 64 }, async base => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(base + endpoint, { method: "POST", headers }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.write(" ".repeat(65)); req.end();
    });
    assert.equal(status, 413);
  });
});

test("worker timeout and disconnect cancellation terminate CPU work", async () => {
  const workerUrl = new URL("data:text/javascript,while(true){}");
  await assert.rejects(runPublishValidation("{}", {}, { timeoutMs: 50, workerUrl }), { status: 503 });
  const controller = new AbortController();
  const pending = runPublishValidation("{}", {}, { timeoutMs: 10000, signal: controller.signal, workerUrl });
  controller.abort();
  await assert.rejects(pending, { status: 503 });
});

test("invalid deployment budgets fail configuration", () => {
  for (const value of [0, -1, NaN, 1.5]) {
    assert.throws(() => loadConfig({ publishValidationMaxConcurrent: value }), /Invalid publish validation budget/);
  }
});

test("human session authentication works and expired sessions cannot validate", async () => {
  const secret = "preflight-session-test-secret";
  const store = {
    getSessionByTokenHash: async hash => hash === hashSessionToken("valid-token", secret) ? { userId: "publisher" } : null,
    getUserById: async id => ({ id, email: "publisher@example.test", displayName: "Publisher" }),
    getRoles: async () => ["user"],
    getDeveloperProfile: async () => null
  };
  await withServer({ sessionSecret: secret }, async base => {
    for (const [token, expected] of [["valid-token", 200], ["expired-token", 401]]) {
      const res = await fetch(base + endpoint, { method: "POST", headers: {
        Cookie: `catsco_session=${token}`, "Content-Type": "application/json"
      }, body: valid });
      assert.equal(res.status, expected);
    }
  }, store);
});

test("client disconnect releases a pending read slot without waiting for deadline", async () => {
  await withServer({ publishValidationMaxConcurrent: 1, publishValidationReadTimeoutMs: 10000 }, async base => {
    const req = http.request(base + endpoint, { method: "POST", headers });
    req.on("error", () => {});
    req.write("{");
    let busy;
    for (let count = 0; count < 10 && busy !== 503; count += 1) {
      busy = (await fetch(base + endpoint + "/rules", { headers })).status;
    }
    assert.equal(busy, 503);
    req.destroy();
    let recovered;
    for (let count = 0; count < 10 && recovered !== 200; count += 1) {
      recovered = (await fetch(base + endpoint + "/rules", { headers })).status;
    }
    assert.equal(recovered, 200);
  });
});

test("timed-out and disconnected authentication retains admission until its query settles", async () => {
  for (const mode of ["timeout", "disconnect"]) {
    let settleAuth;
    let startedAuth;
    let authCalls = 0;
    const started = new Promise(resolve => { startedAuth = resolve; });
    const pending = new Promise(resolve => { settleAuth = resolve; });
    const store = { getSessionByTokenHash: () => {
      authCalls += 1;
      startedAuth();
      return pending;
    } };
    await withServer({ publishValidationMaxConcurrent: 1, publishValidationReadTimeoutMs: 100 }, async base => {
      const authHeaders = { Cookie: "catsco_session=pending-auth", "Content-Type": "application/json" };
      if (mode === "timeout") {
        const response = await fetch(base + endpoint, { method: "POST", headers: authHeaders, body: valid });
        assert.equal(response.status, 503);
      } else {
        const req = http.request(base + endpoint, { method: "POST", headers: authHeaders });
        req.on("error", () => {});
        req.end(valid);
        await started;
        req.destroy();
      }
      for (let count = 0; count < 3; count += 1) {
        const blocked = await fetch(base + endpoint + "/rules", { headers: authHeaders });
        assert.equal(blocked.status, 503, mode);
      }
      assert.equal(authCalls, 1, mode);
      // Resolve to an expired session: the underlying auth rejects. The slot
      // must still be released without creating an unhandled rejection.
      settleAuth(null);
      const recovered = await fetch(base + endpoint + "/rules", { headers });
      assert.equal(recovered.status, 200, mode);
    }, store);
  }
});
