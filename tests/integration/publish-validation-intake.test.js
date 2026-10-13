import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { decodeSource, IntakeError } from "../../packages/publish-validation/intake.js";
import { validatePublishRequest } from "../../packages/publish-validation/index.js";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries, comment = "") {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const name = Buffer.from(entry.path ?? "SKILL.md");
    const localName = Buffer.from(entry.localPath ?? name);
    const method = entry.method ?? 8;
    const packed = method === 8 ? deflateRawSync(content) : content;
    const flags = entry.flags ?? (entry.descriptor ? 8 : 0);
    const crc = entry.crc ?? crc32(content);
    const size = entry.size ?? content.length;
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor === "signature" ? 16 : entry.descriptor ? 12 : 0);
    if (descriptor.length) {
      const at = descriptor.length === 16 ? 4 : 0;
      if (at) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, at);
      descriptor.writeUInt32LE(packed.length, at + 4);
      descriptor.writeUInt32LE(size, at + 8);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.attrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    const localBytes = Buffer.concat([local, localName, extra, packed, descriptor]);
    locals.push(localBytes);
    centrals.push(Buffer.concat([central, name, extra]));
    offset += localBytes.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, central, eocd, Buffer.from(comment)]);
}
const fromZip = (archive, limits) => decodeSource({ source: { type: "zip", archiveBase64: archive.toString("base64") } }, limits);
const fromFiles = (files, limits) => decodeSource({ source: { type: "files", files } }, limits);
function rejects(action, code, status) {
  assert.throws(action, (error) => error instanceof IntakeError && error.code === code && error.status === status);
}

test("files preserves raw bytes, paths, duplicates, and explicit empty contents for later validation", () => {
  const result = fromFiles([{ path: "a/../SKILL.md", content: "\ufeffx\r\n" }, { path: "a/../SKILL.md", contentBase64: "" }]);
  assert.deepEqual(result, [{ path: "a/../SKILL.md", buffer: Buffer.from("\ufeffx\r\n") }, { path: "a/../SKILL.md", buffer: Buffer.alloc(0) }]);
});

test("source schema rejects ambiguous or coercible content and unknown fields", () => {
  for (const body of [
    null, [], {}, { source: [] },
    { source: { type: "other" } },
    { source: { type: "files", files: {} } },
    { source: { type: "files", files: [] }, manifest: {}, form: {} },
    { source: { type: "files", files: [] }, manifest: null },
    { source: { type: "files", files: [] }, form: [] },
    { source: { type: "files", files: [] }, url: "https://example.com" },
    { source: { type: "zip", contentBase64: "" } },
    { source: { type: "zip", archiveBase64: 12 } },
    { source: { type: "files", files: [], archiveBase64: "" } }
  ]) rejects(() => decodeSource(body), "request.invalid", 400);
  for (const file of [null, { path: "a" }, { path: 1, content: "" }, { path: "a", content: {} }, { path: "a", content: 0 }, { path: "a", contentBase64: [] }, { path: "a", content: "", contentBase64: "" }, { path: "a", content: "", type: "symlink" }]) {
    rejects(() => fromFiles([file]), "request.invalid", 400);
  }
});

test("Base64 is canonical, strict and bounded before allocation", () => {
  for (const text of ["YQ", "YQ=", "YQ===", "YQ==\n", "Y!==", "YR==", "YWJ=", "====", "YQ--", " YQ="]) {
    rejects(() => fromFiles([{ path: "x", contentBase64: text }]), "source.base64_invalid", 400);
  }
  assert.equal(fromFiles([{ path: "x", contentBase64: "YQ==" }])[0].buffer.toString(), "a");
  rejects(() => fromFiles([{ path: "x", contentBase64: "YWJj" }], { maxSingleFileBytes: 2 }), "file.limit_exceeded", 413);
  rejects(() => fromZip(zip([{ content: "x" }]), { uploadMaxBytes: 8 }), "package.limit_exceeded", 413);
});

test("files applies actual UTF-8, per-file, count and aggregate boundaries", () => {
  assert.equal(fromFiles([{ path: "x", content: "中" }], { maxSingleFileBytes: 3, maxExpandedBytes: 3 })[0].buffer.length, 3);
  rejects(() => fromFiles([{ path: "x", content: "中" }], { maxSingleFileBytes: 2 }), "file.limit_exceeded", 413);
  rejects(() => fromFiles([{ path: "x", content: "ab" }, { path: "y", content: "cd" }], { maxExpandedBytes: 3 }), "package.limit_exceeded", 413);
  rejects(() => fromFiles([{ path: "x", content: "" }, { path: "y", content: "" }], { maxFiles: 1 }), "package.limit_exceeded", 413);
});

test("stored/deflated ZIPs and both data descriptors preserve content", () => {
  for (const method of [0, 8]) {
    for (const descriptor of [false, "signature", "plain"]) {
      const result = fromZip(zip([
        { path: "assets/", method, descriptor, attrs: 0x41ed0010 },
        { path: "SKILL.md", content: "---\r\nname: 演示\r\n---\r\n", method, descriptor },
        { path: "assets/blob", content: Buffer.from([0, 255, 1]), method, descriptor }
      ], "ordinary comment"));
      assert.deepEqual(result, [
        { path: "SKILL.md", buffer: Buffer.from("---\r\nname: 演示\r\n---\r\n") },
        { path: "assets/blob", buffer: Buffer.from([0, 255, 1]) }
      ]);
    }
  }
});

test("ZIP raw unsafe names, special entries and prefix conflicts stop before decompression", () => {
  for (const path of ["../secret", "a/../b", "a//b", "a/./b", "/secret", "C:/secret", "~/.env", "a\\b", "a\u0000b", "../"]) {
    rejects(() => fromZip(zip([{ path }])), "path.unsafe", 422);
  }
  for (const attrs of [0xa1ff0000, 0x11ff0000, 0x21ff0000, 0x41ed0010]) {
    rejects(() => fromZip(zip([{ path: "link", attrs }])), "path.unsafe", 422);
  }
  rejects(() => fromZip(zip([{ path: "folder/", attrs: 0xa1ff0000 }])), "path.unsafe", 422);
  rejects(() => fromZip(zip([{ path: "x" }, { path: "x" }])), "path.duplicate", 422);
  rejects(() => fromZip(zip([{ path: "x/" }, { path: "x" }])), "path.collision", 422);
  rejects(() => fromZip(zip([{ path: "x" }, { path: "x/y" }])), "path.collision", 422);
  rejects(() => fromZip(zip([{ path: "x/y" }, { path: "x" }])), "path.collision", 422);
  rejects(() => fromZip(zip([{ path: "abcd" }]), { maxPathLength: 3 }), "path.unsafe", 422);
  rejects(() => fromZip(zip([{ path: "a/b" }]), { maxPathDepth: 1 }), "path.unsafe", 422);
});

test("ZIP advertized and actual decompression limits both apply", () => {
  rejects(() => fromZip(zip([{ content: "1234" }]), { maxSingleFileBytes: 3 }), "file.limit_exceeded", 413);
  rejects(() => fromZip(zip([{ content: "x".repeat(10000), size: 1 }]), { maxSingleFileBytes: 32 }), "file.limit_exceeded", 413);
  rejects(() => fromZip(zip([{ path: "a", content: "123" }, { path: "b", content: "123" }]), { maxExpandedBytes: 5 }), "package.limit_exceeded", 413);
  rejects(() => fromZip(zip([{ path: "a", content: "12" }, { path: "b", content: "x".repeat(10000), size: 1 }]), { maxExpandedBytes: 5 }), "package.limit_exceeded", 413);
  rejects(() => fromZip(zip([{ path: "a" }, { path: "b" }]), { maxFiles: 1 }), "package.limit_exceeded", 413);
  assert.equal(fromZip(zip([{ content: "123" }]), { maxSingleFileBytes: 3, maxExpandedBytes: 3 })[0].buffer.length, 3);
});

test("ZIP verifies CRC, raw name, local/central metadata and descriptors", () => {
  assert.equal(fromZip(zip([{ content: "123456789", crc: 0xcbf43926 }]))[0].buffer.toString(), "123456789");
  rejects(() => fromZip(zip([{ content: "abc", crc: 123 }])), "archive.invalid", 422);
  rejects(() => fromZip(zip([{ content: "abc", size: 2 }])), "archive.invalid", 422);
  rejects(() => fromZip(zip([{ path: "a", localPath: "b", content: "x" }])), "archive.invalid", 422);
  for (const at of [6, 8, 14, 18, 22, 26, 28]) {
    const archive = zip([{ content: "abc" }]);
    archive[at] ^= 1;
    rejects(() => fromZip(archive), "archive.invalid", 422);
  }
  const descriptor = zip([{ content: "abc", descriptor: "signature" }]);
  const centralStart = descriptor.readUInt32LE(descriptor.length - 6);
  descriptor[centralStart - 12] ^= 1;
  rejects(() => fromZip(descriptor), "archive.invalid", 422);
});

test("ZIP rejects encryption, ZIP64, multidisk and unsupported encodings/features", () => {
  for (const flags of [1, 0x40, 0x2000]) rejects(() => fromZip(zip([{ flags }])), "archive.encrypted", 422);
  rejects(() => fromZip(zip([{ flags: 0x10 }])), "archive.unsupported", 422);
  rejects(() => fromZip(zip([{ method: 12 }])), "archive.unsupported", 422);
  for (const id of [1, 0x7075]) {
    const extra = Buffer.alloc(4);
    extra.writeUInt16LE(id);
    rejects(() => fromZip(zip([{ extra }])), "archive.unsupported", 422);
  }
  const disk = zip([{ content: "x" }]);
  disk.writeUInt16LE(1, disk.length - 18);
  rejects(() => fromZip(disk), "archive.unsupported", 422);
  const zip64 = zip([{ content: "x" }]);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  rejects(() => fromZip(zip64), "archive.unsupported", 422);
  const badUtf8 = zip([{ path: Buffer.from([0xff]) }]);
  rejects(() => fromZip(badUtf8), "archive.unsupported", 422);
});

test("ZIP rejects every truncation and never leaks host RangeErrors or source text", () => {
  const valid = zip([{ content: "private-secret-must-not-leak", descriptor: "signature" }]);
  for (let length = 0; length < valid.length; length += 1) {
    assert.throws(() => fromZip(valid.subarray(0, length)), (error) => error instanceof IntakeError && !error.message.includes("private-secret"));
  }
  assert.throws(() => fromZip(zip([{ path: "/secret-token-123" }])), (error) => error instanceof IntakeError && error.entryIndex === 0 && !error.message.includes("secret-token"));
});

test("ZIP forbids hidden gaps, trailing bytes and overlapping local records", () => {
  const archive = zip([{ path: "a", content: "abc" }, { path: "b", content: "def" }]);
  const centralStart = archive.readUInt32LE(archive.length - 6);
  const overlap = Buffer.from(archive);
  overlap.writeUInt32LE(0, centralStart + 47 + 42);
  rejects(() => fromZip(overlap), "archive.invalid", 422);
  rejects(() => fromZip(Buffer.concat([archive, Buffer.from("hidden")])), "archive.invalid", 422);
  const gap = Buffer.from(archive);
  gap.writeUInt32LE(1, centralStart + 42);
  rejects(() => fromZip(gap), "archive.invalid", 422);
});

test("ZIP offset/length mutations remain bounded and produce only safe intake failures", () => {
  const seed = zip([{ path: "SKILL.md", content: "example" }, { path: "assets/a", content: "hello", descriptor: "signature" }]);
  for (let index = 0; index < seed.length; index += 1) {
    for (const byte of [0, 0xff]) {
      const mutated = Buffer.from(seed);
      mutated[index] = byte;
      try {
        const result = fromZip(mutated);
        assert.ok(result.every((entry) => Buffer.isBuffer(entry.buffer)));
      } catch (error) {
        assert.ok(error instanceof IntakeError, `Unexpected exception at byte ${index}: ${error.name}`);
        assert.ok([400, 413, 422].includes(error.status));
        assert.ok(error.message.length < 120);
      }
    }
  }
});

test("preflight candidate hashes and verdicts match files/stored ZIP/deflated ZIP regardless of order", () => {
  const entries = [
    { path: "SKILL.md", content: "\ufeff---\r\nname: 文档读取\r\ndescription: |\r\n  Read a document.\r\n  返回文档内容。\r\n---\r\n# Example\r\n" },
    { path: "skill.json", content: '{"license":"MIT","version":"1.2.3"}' },
    { path: "assets/二进制", content: Buffer.from([0, 0xff, 0xfe, 0x42]) }
  ];
  const manifest = { displayName: "文档读取", runtime: { platforms: ["linux"] } };
  const run = source => validatePublishRequest(JSON.stringify({ source, manifest }));
  const fileSource = { type: "files", files: entries.map(({ path, content }) => ({ path, contentBase64: Buffer.from(content).toString("base64") })) };
  const original = run(fileSource);
  assert.equal(original.status, 200);
  const { candidateHash } = original.body.validation;
  for (const method of [0, 8]) {
    for (const ordered of [entries, [...entries].reverse()]) {
      for (const descriptor of [false, "signature", "plain"]) {
        const result = run({ type: "zip", archiveBase64: zip(ordered.map(entry => ({ ...entry, method, descriptor }))).toString("base64") });
        assert.equal(result.status, 200);
        assert.equal(result.body.validation.candidateHash, candidateHash);
        assert.equal(result.body.validation.outcome, original.body.validation.outcome);
        assert.equal(result.body.validation.coverage, original.body.validation.coverage);
        assert.deepEqual(result.body.validation.issues, original.body.validation.issues);
      }
    }
  }
  assert.equal(run({ ...fileSource, files: [...fileSource.files].reverse() }).body.validation.candidateHash, candidateHash);
});

test("files and ZIP return the same missing-description rule and confirmation policy", () => {
  const entries = [
    { path: "SKILL.md", content: "---\nname: sample\n---\n# Description is intentionally absent\n" },
    { path: "README.md", content: "This must not replace the missing runtime description." }
  ];
  const run = source => validatePublishRequest(JSON.stringify({ source, manifest: { description: "External description must not fill runtime metadata." } }));
  const original = run({ type: "files", files: entries });
  assert.equal(original.status, 422);
  const expected = original.body.error.validation;
  assert.deepEqual(expected.issues.map(({ code }) => code), ["metadata.description_missing"]);
  for (const method of [0, 8]) {
    for (const ordered of [entries, [...entries].reverse()]) {
      const result = run({ type: "zip", archiveBase64: zip(ordered.map(entry => ({ ...entry, method }))).toString("base64") });
      assert.equal(result.status, 422);
      const report = result.body.error.validation;
      assert.equal(report.candidateHash, expected.candidateHash);
      assert.equal(report.coverage, "complete");
      assert.equal(report.nextAction, "review_report");
      assert.deepEqual(report.issues.map(({ code, repairPolicy, blocking }) => ({ code, repairPolicy, blocking })),
        expected.issues.map(({ code, repairPolicy, blocking }) => ({ code, repairPolicy, blocking })));
      assert.equal(report.issues[0].location.entryIndex, ordered.findIndex(entry => entry.path === "SKILL.md"));
      assert.equal(report.issues[0].location.field, "description");
    }
  }
});
