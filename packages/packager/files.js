import path from 'node:path';
import { sha256 } from '../domain/index.js';

// Shared by legacy packaging and strict final-package preparation. Do not
// introduce a second, subtly different materialization in the validator.
export function computeSkillContentHash(files) {
  const entries = sourceFileEntries(files).map(file => {
    const buffer = skillHashBuffer(file.path, file.buffer);
    return { path: file.path, size: buffer.length, sha256: sha256(buffer) };
  });
  return sha256(JSON.stringify(entries));
}

function skillHashBuffer(filePath, buffer) {
  if (filePath !== 'SKILL.md') return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

export function normalizePackageFiles(files) {
  const byPath = new Map();
  for (const file of sourceFileEntries(files)) {
    const buffer = skillHashBuffer(file.path, file.buffer);
    byPath.set(file.path, { path: file.path, size: buffer.length,
      sha256: sha256(buffer), contentBase64: buffer.toString('base64') });
  }
  return [...byPath.values()].sort(compareFilePaths);
}

function sourceFileEntries(files) {
  return files.map(file => ({ path: file.path, buffer: fileBuffer(file) }))
    .filter(file => path.basename(file.path) !== 'skill.json').sort(compareFilePaths);
}
function compareFilePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
function fileBuffer(file) {
  if (file.buffer) return file.buffer;
  if (file.contentBase64) return Buffer.from(file.contentBase64, 'base64');
  return Buffer.from(String(file.content ?? ''), 'utf8');
}
