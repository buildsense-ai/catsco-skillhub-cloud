import { inflateRawSync } from "node:zlib";

const MESSAGES = Object.freeze({
  "request.invalid": "The publication source has an invalid shape.",
  "source.base64_invalid": "The source must use canonical padded Base64.",
  "archive.invalid": "The ZIP structure, size, or checksum is invalid.",
  "archive.unsupported": "The ZIP uses an unsupported archive feature.",
  "archive.encrypted": "Encrypted ZIP entries are not supported.",
  "path.unsafe": "A package entry is not a safe relative regular file or directory.",
  "path.duplicate": "The archive contains duplicate package paths.",
  "path.collision": "A package file conflicts with a directory path.",
  "package.limit_exceeded": "The package exceeds a configured processing limit.",
  "file.limit_exceeded": "A file exceeds the configured byte limit."
});

export class IntakeError extends Error {
  constructor(code, status = 422, entryIndex) {
    super(MESSAGES[code] ?? MESSAGES["archive.invalid"]);
    this.name = "IntakeError";
    this.code = Object.hasOwn(MESSAGES, code) ? code : "archive.invalid";
    this.status = status;
    if (Number.isSafeInteger(entryIndex) && entryIndex >= 0) this.entryIndex = entryIndex;
  }
}

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 500,
  maxSingleFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  uploadMaxBytes: 50 * 1024 * 1024,
  maxPathLength: 180,
  maxPathDepth: 12
});
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code, status = 422, index) { throw new IntakeError(code, status, index); }
function exactKeys(value, allowed) {
  return object(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function boundedLimits(input) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw new TypeError("Invalid intake limit.");
      limits[key] = input[key];
    }
  }
  return limits;
}

// This is deliberately separate from the legacy share decoder. It never coerces
// objects to strings, normalizes paths, writes files, or executes uploaded code.
export function decodeSource(body, inputLimits = {}) {
  const limits = boundedLimits(inputLimits);
  if (!exactKeys(body, ["source", "manifest", "form"]) || !object(body.source)
      || (own(body, "manifest") && own(body, "form"))
      || (own(body, "manifest") && !object(body.manifest))
      || (own(body, "form") && !object(body.form))) fail("request.invalid", 400);
  const source = body.source;
  if (source.type === "zip") {
    if (!exactKeys(source, ["type", "archiveBase64"]) || typeof source.archiveBase64 !== "string") fail("request.invalid", 400);
    return decodeZip(decodeBase64(source.archiveBase64, limits.uploadMaxBytes), limits);
  }
  if (source.type !== "files" || !exactKeys(source, ["type", "files"]) || !Array.isArray(source.files)) fail("request.invalid", 400);
  if (source.files.length > limits.maxFiles) fail("package.limit_exceeded", 413);
  let expanded = 0;
  return source.files.map((file, index) => {
    if (!exactKeys(file, ["path", "content", "contentBase64"]) || typeof file.path !== "string"
        || own(file, "content") === own(file, "contentBase64")) fail("request.invalid", 400, index);
    const contentKey = own(file, "content") ? "content" : "contentBase64";
    if (typeof file[contentKey] !== "string" || !file.path.isWellFormed()
        || !file[contentKey].isWellFormed()) fail("request.invalid", 400, index);
    let buffer;
    if (contentKey === "contentBase64") {
      buffer = decodeBase64(file.contentBase64, limits.maxSingleFileBytes, "file.limit_exceeded", index);
    } else {
      if (Buffer.byteLength(file.content, "utf8") > limits.maxSingleFileBytes) fail("file.limit_exceeded", 413, index);
      buffer = Buffer.from(file.content, "utf8");
    }
    expanded += buffer.length;
    if (expanded > limits.maxExpandedBytes) fail("package.limit_exceeded", 413, index);
    return { path: file.path, buffer };
  });
}

function decodeBase64(text, maxBytes, limitCode = "package.limit_exceeded", index) {
  if (text.length % 4 !== 0) fail("source.base64_invalid", 400, index);
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = text.length / 4 * 3 - padding;
  if (bytes > maxBytes) fail(limitCode, 413, index);
  // Scan rather than use a repeated-group regexp on multi-megabyte input.
  for (let at = 0; at < text.length - padding; at += 1) {
    const ch = text.charCodeAt(at);
    if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 47)) {
      fail("source.base64_invalid", 400, index);
    }
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== text) fail("source.base64_invalid", 400, index);
  return decoded;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeName(buffer, index) {
  try { return UTF8.decode(buffer); } catch { fail("archive.unsupported", 422, index); }
}
function safeZipPath(raw, limits, index, directory) {
  const path = directory ? raw.slice(0, -1) : raw;
  if (!path || path.length > limits.maxPathLength || /[\\\u0000-\u001f\u007f]/u.test(path)
      || path.startsWith("/") || path.startsWith("~") || /^[a-z]:/i.test(path)) fail("path.unsafe", 422, index);
  const segments = path.split("/");
  if (segments.length > limits.maxPathDepth || segments.some((part) => !part || part === "." || part === "..")) fail("path.unsafe", 422, index);
  return path;
}
function extraFields(buffer, start, length, index) {
  const end = start + length;
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) fail("archive.invalid", 422, index);
    const id = buffer.readUInt16LE(offset);
    const size = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > end) fail("archive.invalid", 422, index);
    // ZIP64 and alternate filename representations must not bypass raw-path checks.
    if (id === 0x0001 || id === 0x7075) fail("archive.unsupported", 422, index);
    offset += size;
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeZip(buffer, limits) {
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { eocd = at; break; }
  }
  if (eocd < 0) fail("archive.invalid");
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralStart = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)
      || entries === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff
      || (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === 0x07064b50)) fail("archive.unsupported");
  if (buffer.readUInt16LE(eocd + 8) !== entries || centralStart + centralSize !== eocd) fail("archive.invalid");
  if (entries > limits.maxFiles) fail("package.limit_exceeded", 413);
  const records = [];
  const paths = new Map();
  let offset = centralStart;
  let advertisedExpanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) fail("archive.invalid", 422, index);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const packedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const disk = buffer.readUInt16LE(offset + 34);
    const attrs = buffer.readUInt32LE(offset + 38);
    const start = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > eocd) fail("archive.invalid", 422, index);
    if (flags & 0x2041) fail("archive.encrypted", 422, index);
    if (disk || packedSize === 0xffffffff || size === 0xffffffff || start === 0xffffffff
        || buffer.readUInt16LE(offset + 6) > 20 || ![0, 8].includes(method)
        || (flags & ~0x080e) || (method === 0 && (flags & 6))) fail("archive.unsupported", 422, index);
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = decodeName(nameBytes, index);
    const directory = rawName.endsWith("/");
    const mode = (attrs >>> 16) & 0o170000;
    if (![0, 0o040000, 0o100000].includes(mode) || (mode === 0o040000 && !directory)
        || (mode === 0o100000 && directory) || ((attrs & 0x10) && !directory)) fail("path.unsafe", 422, index);
    const path = safeZipPath(rawName, limits, index, directory);
    if (paths.has(path)) fail(paths.get(path) === directory ? "path.duplicate" : "path.collision", 422, index);
    paths.set(path, directory);
    extraFields(buffer, offset + 46 + nameLength, extraLength, index);
    if (size > limits.maxSingleFileBytes) fail("file.limit_exceeded", 413, index);
    advertisedExpanded += size;
    if (advertisedExpanded > limits.maxExpandedBytes) fail("package.limit_exceeded", 413, index);
    if (directory && size !== 0) fail("archive.invalid", 422, index);
    records.push({ index, flags, method, crc, packedSize, size, start, nameBytes, rawName, directory });
    offset = recordEnd;
  }
  if (offset !== eocd) fail("archive.invalid");
  for (const path of paths.keys()) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      if (paths.get(parts.slice(0, end).join("/")) === false) fail("path.collision");
    }
  }
  // Bound each local record by the next one, not just by the central directory.
  // This also rejects aliases, hidden unindexed records, and overlapping payloads.
  const physical = [...records].sort((a, b) => a.start - b.start);
  if ((physical[0]?.start ?? centralStart) !== 0) fail("archive.invalid");
  let actualExpanded = 0;
  const files = [];
  for (let position = 0; position < physical.length; position += 1) {
    const record = physical[position];
    const { index, flags, method, crc, packedSize, size, start } = record;
    const end = physical[position + 1]?.start ?? centralStart;
    if (start + 30 > end || end > centralStart || buffer.readUInt32LE(start) !== 0x04034b50) fail("archive.invalid", 422, index);
    const nameLength = buffer.readUInt16LE(start + 26);
    const extraLength = buffer.readUInt16LE(start + 28);
    const dataStart = start + 30 + nameLength + extraLength;
    const dataEnd = dataStart + packedSize;
    if (dataStart > end || dataEnd > end || buffer.readUInt16LE(start + 4) > 20
        || buffer.readUInt16LE(start + 6) !== flags || buffer.readUInt16LE(start + 8) !== method
        || !buffer.subarray(start + 30, start + 30 + nameLength).equals(record.nameBytes)) fail("archive.invalid", 422, index);
    extraFields(buffer, start + 30 + nameLength, extraLength, index);
    const localValues = [buffer.readUInt32LE(start + 14), buffer.readUInt32LE(start + 18), buffer.readUInt32LE(start + 22)];
    const values = [crc, packedSize, size];
    if (flags & 8) {
      if (localValues.some((value, at) => value !== 0 && value !== values[at])) fail("archive.invalid", 422, index);
      const descriptorLength = end - dataEnd;
      const signature = descriptorLength === 16;
      if (![12, 16].includes(descriptorLength) || (signature && buffer.readUInt32LE(dataEnd) !== 0x08074b50)) fail("archive.invalid", 422, index);
      const descriptorStart = dataEnd + (signature ? 4 : 0);
      if (values.some((value, at) => buffer.readUInt32LE(descriptorStart + at * 4) !== value)) fail("archive.invalid", 422, index);
    } else if (localValues.some((value, at) => value !== values[at]) || dataEnd !== end) fail("archive.invalid", 422, index);
    const allowance = Math.min(limits.maxSingleFileBytes, limits.maxExpandedBytes - actualExpanded);
    let content;
    const packed = buffer.subarray(dataStart, dataEnd);
    if (method === 0) {
      if (packedSize > allowance) fail(packedSize > limits.maxSingleFileBytes ? "file.limit_exceeded" : "package.limit_exceeded", 413, index);
      content = Buffer.from(packed);
    } else {
      try {
        const inflated = inflateRawSync(packed, { maxOutputLength: Math.max(1, allowance), info: true });
        content = inflated.buffer;
        if (inflated.engine.bytesWritten !== packed.length) fail("archive.invalid", 422, index);
      } catch (error) {
        if (error instanceof IntakeError) throw error;
        if (error.code === "ERR_BUFFER_TOO_LARGE") fail(allowance === limits.maxSingleFileBytes ? "file.limit_exceeded" : "package.limit_exceeded", 413, index);
        fail("archive.invalid", 422, index);
      }
    }
    actualExpanded += content.length;
    if (actualExpanded > limits.maxExpandedBytes) fail("package.limit_exceeded", 413, index);
    if (content.length !== size || crc32(content) !== crc) fail("archive.invalid", 422, index);
    if (!record.directory) files.push({ path: record.rawName, buffer: content, index });
  }
  return files.sort((a, b) => a.index - b.index).map(({ path, buffer: content }) => ({ path, buffer: content }));
}
