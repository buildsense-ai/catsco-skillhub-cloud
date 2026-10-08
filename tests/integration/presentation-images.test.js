import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { normalizePresentationImage, IMAGE_MAX_BYTES, IMAGE_REQUEST_MAX_BYTES } from "../../packages/presentations/images.js";
import { parsePresentationContent } from "../../packages/presentations/index.js";
import { createApiServer } from "../../apps/api/server.js";
import { loadConfig } from "../../packages/config/index.js";
import { ValidationError } from "../../packages/domain/index.js";
import { ensurePresentationAssetSchema } from "../../packages/presentations/asset-store.js";

const assetId = `pa_${"a".repeat(32)}`;
const target = { skillId: "owner/read", version: "1.0.0" };
const owner = { userId: "owner", role: "user", roles: ["user"] };
const makeImage = (format = "png", width = 32, height = 24) => sharp({ create: { width, height, channels: 3, background: "red" } }).toFormat(format).toBuffer();

test("image normalization decodes supported formats, strips metadata/trailing content and fixes orientation", async () => {
  for (const format of ["png", "jpeg", "webp"]) {
    const input = await sharp(await makeImage(format)).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const image = await normalizePresentationImage(input.toString("base64"));
    const meta = await sharp(image.data).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    assert.equal(meta.orientation, undefined);
    assert.equal(image.width, 24);
    assert.equal(image.height, 32);
    assert.equal(image.width, meta.width);
  }
  const appended = Buffer.concat([await makeImage(), Buffer.from('<script>alert("trailing payload")</script>')]);
  const sanitized = await normalizePresentationImage(appended.toString("base64"));
  assert.equal(sanitized.data.includes(Buffer.from("trailing payload")), false);
});

test("image normalization rejects active, malformed, truncated, unsupported and oversized inputs", async () => {
  const original = await makeImage();
  const gif = await makeImage("gif");
  const oversized = await makeImage("png", 4097, 1);
  const tooManyPixels = await makeImage("png", 4001, 4000);
  const badBuffers = [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), Buffer.from("<html>hello</html>"),
    gif, Buffer.from("RIFFinvalidWEBPdata"), original.subarray(0, 20), original.subarray(0, original.length - 20), oversized, tooManyPixels,
    Buffer.alloc(IMAGE_MAX_BYTES + 1)];
  for (const input of [undefined, "", "!!!!", "YQ=", "YR==", "data:image/png;base64," + original.toString("base64"),
    original.toString("base64") + "\n", ...badBuffers.map((buffer) => buffer.toString("base64"))]) {
    await assert.rejects(normalizePresentationImage(input), { code: "presentation.image_invalid" });
  }
  // libvips creates a two-frame animated WebP from vertically stacked pages.
  const animation = await sharp(Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]),
    { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 2);
  await assert.rejects(normalizePresentationImage(animation.toString("base64")), { code: "presentation.image_invalid" });
  const actl = Buffer.alloc(20);
  actl.writeUInt32BE(8, 0);
  actl.write("acTL", 4, "ascii");
  actl.writeUInt32BE(2, 8);
  const apng = Buffer.concat([original.subarray(0, 33), actl, original.subarray(33)]);
  await assert.rejects(normalizePresentationImage(apng.toString("base64")), { code: "presentation.image_invalid" });
});

test("structured images accept bounded IDs and accessible text, never caller URLs or HTML fields", () => {
  const base = { schemaVersion: 1, summary: "Read", primaryCategory: "documents" };
  const item = { assetId, alt: "Document result", caption: "Illustrative only" };
  assert.deepEqual(parsePresentationContent({ ...base, images: [item] }).images, [item]);
  assert.equal(Object.hasOwn(parsePresentationContent(base), "images"), false);
  for (const images of [[{ ...item, url: "http://localhost/" }], [{ ...item, assetId: "../secret" }],
    [{ ...item, alt: " " }], [{ ...item, caption: "x".repeat(501) }], [item, item], Array(7).fill(item), null]) {
    assert.throws(() => parsePresentationContent({ ...base, images }), { code: "presentation.invalid" });
  }
});

async function withApi(t, overrides = {}) {
  const calls = [];
  const config = loadConfig({ nodeEnv: "test", sessionSecret: "local-test-secret", agentClientSecret: "test-agent-secret", ...overrides });
  const data = await makeImage("webp");
  const asset = { id: assetId, mimeType: "image/webp", width: 32, height: 24, size: data.length };
  const store = {
    getSessionByTokenHash: async () => ({ userId: "owner" }), getUserById: async () => ({ id: "owner" }),
    getRoles: async () => ["user"], getDeveloperProfile: async () => null, listPublishedVersions: async () => [],
    checkPresentationAssetUpload: async (...args) => { calls.push(["check", ...args]); },
    createPresentationAsset: async (...args) => { calls.push(["create", ...args]); return asset; },
    listPresentationAssets: async (...args) => { calls.push(["list", ...args]); return [asset]; },
    getPresentationAsset: async (...args) => { calls.push(["get", ...args]); return { ...asset, data }; },
    deletePresentationAsset: async (...args) => { calls.push(["delete", ...args]); return { deleted: true }; }
  };
  const server = createApiServer(config, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  const upload = { method: "POST", headers: { "Content-Type": "application/json", Cookie: "catsco_session=test" },
    body: JSON.stringify({ ...target, dataBase64: (await makeImage()).toString("base64") }) };
  return { request, upload, calls, store, data };
}
const base = "/api/skill-presentations/assets";

test("image API authenticates humans and validates origin/body before decoding or writing", async (t) => {
  const { request, upload, calls, store } = await withApi(t);
  for (const [headers, expected] of [[{ "Content-Type": "application/json" }, 401],
    [{ ...upload.headers, Cookie: "", Authorization: "Bearer test-agent-secret" }, 401],
    [{ ...upload.headers, Origin: "https://evil.invalid" }, 403], [{ ...upload.headers, "Content-Type": "image/png" }, 415]]) {
    assert.equal((await request(base, { ...upload, headers })).status, expected);
  }
  assert.equal((await request(base, { ...upload, body: JSON.stringify({ ...target, url: "http://localhost/private" }) })).status, 400);
  assert.equal((await request(base, { ...upload, body: " ".repeat(IMAGE_REQUEST_MAX_BYTES + 1) })).status, 413);
  assert.equal(calls.length, 0);
  store.checkPresentationAssetUpload = async () => { throw new ValidationError("Not found", "presentation.not_found", 404); };
  assert.equal((await request(base, { ...upload, body: JSON.stringify({ ...target, dataBase64: "invalid" }) })).status, 404);
  assert.equal(calls.length, 0);
});

test("image API returns normalized metadata, private previews and noncacheable public bytes", async (t) => {
  const { request, upload, calls, data } = await withApi(t);
  const response = await request(base, { ...upload, headers: { ...upload.headers, "X-Real-IP": "192.0.2.30" } });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).asset.id, assetId);
  assert.equal(calls[0][0], "check");
  assert.deepEqual(calls[1][1], { ...target, reason: "" });
  assert.equal(calls[1][2].userId, owner.userId);
  assert.equal(calls[1][4], "192.0.2.30");
  assert.equal((await sharp(calls[1][3].data).metadata()).format, "webp");
  assert.equal((await request(`${base}?skillId=owner%2Fread&version=1.0.0`)).status, 401);
  assert.equal((await request(`${base}?skillId=owner%2Fread&version=1.0.0`, { headers: upload.headers })).status, 200);
  assert.equal((await request(`${base}/${assetId}/preview`)).status, 401);
  const preview = await request(`${base}/${assetId}/preview`, { headers: upload.headers });
  assert.equal(preview.status, 200);
  assert.equal(calls.at(-1)[2].actor.userId, "owner");
  assert.equal(calls.at(-1)[2].draft, true);
  const image = await request(`${base}/${assetId}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /^image\/webp$/);
  assert.match(image.headers.get("cache-control"), /no-store/);
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.match(image.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), data);
  assert.equal(calls.at(-1)[2].draft, false);
  assert.equal(calls.at(-1)[2].actor, undefined);
  assert.equal((await request(`${base}/${assetId}`, { ...upload, method: "DELETE", body: JSON.stringify(target) })).status, 200);
});

test("image feature guards and missing schema do not disable legacy catalogue", async (t) => {
  const { request, upload } = await withApi(t, { presentationImagesEnabled: false });
  assert.equal((await request(base, upload)).status, 503);
  assert.equal((await request(`${base}/${assetId}`)).status, 503);
  assert.equal((await request("/api/skills")).status, 200);
  const readOnly = await withApi(t, { presentationsWriteEnabled: false });
  assert.equal((await readOnly.request(base, readOnly.upload)).status, 503);
  assert.equal((await readOnly.request(`${base}/${assetId}`)).status, 200);
  assert.equal(loadConfig({ nodeEnv: "production" }).presentations.imagesEnabled, false);
  let ready = false;
  const query = async () => ({ rows: [{ ready }] });
  await assert.rejects(ensurePresentationAssetSchema(query), { code: "presentation.assets_schema_unavailable" });
  ready = true;
  await ensurePresentationAssetSchema(query);
});

test("image API bounds concurrent body/decoder jobs and frees slots after failures", async (t) => {
  const { request, upload, store } = await withApi(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let started = 0;
  let bothStarted;
  const ready = new Promise((resolve) => { bothStarted = resolve; });
  store.checkPresentationAssetUpload = async () => { if (++started === 2) bothStarted(); await gate; };
  const jobs = [request(base, upload), request(base, upload)];
  await ready;
  assert.equal((await request(base, upload)).status, 429);
  release();
  assert.deepEqual((await Promise.all(jobs)).map((response) => response.status), [201, 201]);
  assert.equal((await request(base, { ...upload, body: JSON.stringify({ ...target, dataBase64: "broken" }) })).status, 400);
  assert.equal((await request(base, upload)).status, 201);
});
