import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../packages/config/index.js";
import { getPool } from "../packages/database/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "infra", "migrations");
const config = loadConfig();

if (!config.databaseUrl) {
  console.error("SKILLHUB_DATABASE_URL is required");
  process.exit(1);
}

const pool = await getPool(config);
const client = await pool.connect();
const files = (await fs.readdir(migrationsDir))
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();

try {
  await client.query(`SELECT pg_advisory_lock(hashtext('catsco_skillhub_migrations')::bigint)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const exists = await client.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [id]);
    if (exists.rowCount) {
      console.log(`skip ${id}`);
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [id]);
      await client.query("COMMIT");
      console.log(`applied ${id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query(`SELECT pg_advisory_unlock(hashtext('catsco_skillhub_migrations')::bigint)`).catch(() => {});
  client.release();
  await pool.end();
}
