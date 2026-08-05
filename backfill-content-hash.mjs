import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

function loadEnv(filePath) {
  const text = requireText(filePath);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function requireText(filePath) {
  return globalThis.__fsReadFileSync(filePath, 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function skillHashBuffer(filePath, buffer) {
  if (filePath !== 'SKILL.md') return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function computeSkillContentHash(files) {
  const entries = files
    .filter(file => path.basename(file.path) !== 'skill.json')
    .map(file => {
      const buffer = skillHashBuffer(file.path, Buffer.from(file.contentBase64, 'base64'));
      return { path: file.path, size: buffer.length, sha256: sha256(buffer) };
    })
    .sort(compareFilePaths);
  return sha256(JSON.stringify(entries));
}

function compareFilePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

globalThis.__fsReadFileSync = (await import('node:fs')).readFileSync;
loadEnv('/opt/catsco/skillhub/shared/.env');

const pool = new Pool({ connectionString: process.env.SKILLHUB_DATABASE_URL });
const dryRun = process.argv.includes('--dry-run');
try {
  const result = await pool.query(`
    SELECT id, skill_id, version, package_path, content_hash, checksum_sha256
    FROM skill_versions
    WHERE status IN ('published', 'yanked')
    ORDER BY published_at DESC
  `);
  let changed = 0;
  for (const row of result.rows) {
    const packageBytes = await fs.readFile(row.package_path);
    if (sha256(packageBytes) !== row.checksum_sha256) {
      throw new Error(`refuse ${row.skill_id}@${row.version}: package checksum mismatch`);
    }
    const pkg = JSON.parse(packageBytes.toString('utf8'));
    const files = pkg?.payload?.files;
    if (!Array.isArray(files)) {
      console.log(`skip ${row.skill_id}@${row.version}: no payload files`);
      continue;
    }
    const actual = computeSkillContentHash(files);
    if (actual !== row.content_hash) {
      if (!dryRun) {
        await pool.query('UPDATE skill_versions SET content_hash = $1 WHERE id = $2', [actual, row.id]);
      }
      changed += 1;
      console.log(`${dryRun ? 'would update' : 'updated'} ${row.skill_id}@${row.version}: ${row.content_hash || '(empty)'} -> ${actual}`);
    } else {
      console.log(`ok ${row.skill_id}@${row.version}: ${actual}`);
    }
  }
  console.log(`done rows=${result.rows.length} changed=${changed} dryRun=${dryRun}`);
} finally {
  await pool.end();
}
