import { ValidationError } from '../domain/index.js';

const conflict = () => new ValidationError('Publication version is reserved for different work.', 'skillhub.publication_version_conflict', 409);
// Preserve the existing manifest contract (including legacy leading zeroes).
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function parts(version) {
  if (typeof version !== 'string' || version.length > 160 || !versionPattern.test(version)) throw conflict();
  return version.split(/[+-]/)[0].split('.').map(BigInt);
}
export function comparePublicVersions(a, b) {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function nextAvailablePublicVersion(requested, occupied) {
  parts(requested);
  let latest = null;
  for (const version of occupied) {
    // Corrupt historical data must not make an allocation silently unsafe.
    parts(version);
    if (latest === null || comparePublicVersions(version, latest) > 0) latest = version;
  }
  if (latest === null || comparePublicVersions(requested, latest) > 0) return requested;
  const [major, minor, patch] = parts(latest);
  const next = `${major}.${minor}.${patch + 1n}`;
  parts(next);
  return next;
}

export async function lockPublicSkill(client, skillId) {
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`skillhub-public-version:${skillId}`]);
}

async function reserve(client, input, exact) {
  const { uploadId, skillId, ownerId, version } = input;
  if (![uploadId, skillId, ownerId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) throw conflict();
  parts(version);
  await lockPublicSkill(client, skillId);
  const skill = (await client.query('SELECT owner_user_id FROM skills WHERE id=$1 FOR SHARE', [skillId])).rows[0];
  if (skill && skill.owner_user_id !== ownerId) throw conflict();
  const first = (await client.query('SELECT owner_user_id FROM publication_version_reservations WHERE skill_id=$1 LIMIT 1', [skillId])).rows[0];
  if (first && first.owner_user_id !== ownerId) throw conflict();
  const pendingOwner = (await client.query(`SELECT COALESCE(NULLIF(payload->'publisher'->>'userId',''),payload->'publisher'->>'id') AS owner_id
    FROM jobs WHERE type='publish_skill_version' AND payload->'manifest'->>'id'=$1 ORDER BY created_at,id LIMIT 1`, [skillId])).rows[0];
  if (pendingOwner && pendingOwner.owner_id !== ownerId) throw conflict();
  const prior = (await client.query('SELECT * FROM publication_version_reservations WHERE upload_id=$1', [uploadId])).rows[0];
  if (prior) {
    if (prior.skill_id !== skillId || prior.owner_user_id !== ownerId ||
      (exact ? prior.version !== version : prior.requested_version !== version)) throw conflict();
    return prior;
  }
  let allocated = version;
  if (exact) {
    // Compatibility adoption of pre-migration jobs: never silently renumber
    // files that already embed version metadata or an existing Git tag.
    const occupied = await client.query(`SELECT upload_id FROM skill_versions WHERE skill_id=$1 AND version=$2
      UNION ALL SELECT upload_id FROM publication_version_reservations WHERE skill_id=$1 AND version=$2`, [skillId, version]);
    if (occupied.rows.some(row => row.upload_id !== uploadId)) throw conflict();
    const older = await client.query(`SELECT payload->>'uploadId' AS upload_id FROM jobs
      WHERE type='publish_skill_version' AND payload->'manifest'->>'id'=$1 AND payload->'manifest'->>'version'=$2
      ORDER BY created_at,id LIMIT 1`, [skillId, version]);
    if (older.rows[0] && older.rows[0].upload_id !== uploadId) throw conflict();
  } else {
    const occupied = await client.query(`SELECT version FROM skill_versions WHERE skill_id=$1
      UNION ALL SELECT version FROM publication_version_reservations WHERE skill_id=$1
      UNION ALL SELECT payload->'manifest'->>'version' AS version FROM jobs
        WHERE type='publish_skill_version' AND payload->'manifest'->>'id'=$1`, [skillId]);
    allocated = nextAvailablePublicVersion(version, occupied.rows.map(row => row.version));
  }
  const inserted = await client.query(`INSERT INTO publication_version_reservations
    (upload_id,skill_id,owner_user_id,requested_version,version) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
  [uploadId, skillId, ownerId, version, allocated]);
  return inserted.rows[0];
}

// Used inside the package transaction as well as before Git writes.
export function adoptPublicVersion(client, input) { return reserve(client, input, true); }
export function reservePublicVersion(client, input) { return reserve(client, input, false); }

export function createPublicVersionStore({ tx }) {
  return {
    reservePublicVersion: input => tx(client => reserve(client, input, false)),
    adoptPublicVersion: input => tx(client => adoptPublicVersion(client, input))
  };
}
