import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../packages/config/index.js";
import { closePools, getPool } from "../packages/database/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "infra", "migrations");
const config = loadConfig();

if (!config.databaseUrl) {
  console.error("SKILLHUB_DATABASE_URL is required");
  process.exit(1);
}

const files = (await fs.readdir(migrationsDir))
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();

const requestedRetryLimit = Number.parseInt(process.env.SKILLHUB_MIGRATION_RETRIES ?? "3", 10);
const retryLimit = Number.isFinite(requestedRetryLimit)
  ? Math.min(Math.max(requestedRetryLimit, 1), 5)
  : 3;

function isRetryableConnectionError(error) {
  const code = String(error?.code ?? "");
  if (["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "57P01", "57P02", "57P03", "53300"].includes(code)) {
    return true;
  }
  return /connection terminated unexpectedly|connection reset|ECONNRESET|database system is starting up|too many connections/i.test(
    String(error?.message ?? error)
  );
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runMigrations() {
  const pool = await getPool(config);
  const client = await pool.connect();

  // pg reports an unexpected socket close through the Client's EventEmitter.
  // Convert that event into a rejected operation for the retry loop instead
  // of allowing an unhandled process-level error.
  let connectionError;
  client.on("error", (error) => {
    connectionError = error;
  });
  const query = async (text, params) => {
    if (connectionError) throw connectionError;
    const result = await client.query(text, params);
    if (connectionError) throw connectionError;
    return result;
  };

  try {
    await query(`SELECT pg_advisory_lock(hashtext('catsco_skillhub_migrations')::bigint)`);
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const exists = await query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [id]);
      if (exists.rowCount) {
        console.log(`skip ${id}`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      try {
        await query("BEGIN");
        await query(sql);
        await query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [id]);
        await query("COMMIT");
        console.log(`applied ${id}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const migrationError = new Error(`migration ${id} failed: ${error?.message ?? error}`, { cause: error });
        migrationError.code = error?.code;
        throw migrationError;
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('catsco_skillhub_migrations')::bigint)`).catch(() => {});
    client.release(connectionError ?? undefined);
  }
}

let lastError;
try {
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      await runMigrations();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectionError(error) || attempt === retryLimit) {
        throw error;
      }
      console.warn(`database connection interrupted during migration (attempt ${attempt}/${retryLimit}); retrying`);
      await closePools().catch(() => {});
      await sleep(1000 * attempt);
    }
  }
} finally {
  await closePools().catch(() => {});
}

if (lastError) {
  throw lastError;
}
