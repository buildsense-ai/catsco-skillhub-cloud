import zlib from "node:zlib";
import { validatePackagePath } from "../domain/index.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function parseZipArchive(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries > (limits.maxFiles ?? 500)) {
    throw new Error(`zip 文件数量过多: ${totalEntries}`);
  }

  const files = [];
  let offset = centralDirectoryOffset;
  let totalSize = 0;

  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error("zip 中央目录损坏");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (!rawName || rawName.endsWith("/")) continue;
    if (flags & 0x01) throw new Error(`不支持加密 zip 条目: ${rawName}`);
    if (isUnixSymlink(externalAttributes)) throw new Error(`拒绝 zip 符号链接: ${rawName}`);
    if (![0, 8].includes(method)) throw new Error(`不支持的 zip 压缩算法 ${method}: ${rawName}`);

    const packagePath = validatePackagePath(rawName, limits);
    if (uncompressedSize > (limits.maxSingleFileBytes ?? 5 * 1024 * 1024)) {
      throw new Error(`zip 单文件过大: ${packagePath}`);
    }
    totalSize += uncompressedSize;
    if (totalSize > (limits.maxExpandedBytes ?? 100 * 1024 * 1024)) {
      throw new Error("zip 展开后体积超过限制");
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) throw new Error(`zip 本地头损坏: ${packagePath}`);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : zlib.inflateRawSync(compressed);
    if (content.length !== uncompressedSize) throw new Error(`zip 文件大小不匹配: ${packagePath}`);
    files.push({ path: packagePath, buffer: content });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("不是有效 zip 文件或缺少 EOCD");
}

function isUnixSymlink(externalAttributes) {
  const mode = (externalAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

