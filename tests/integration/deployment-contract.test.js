import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("production deploy validates the release symlink before side effects", async () => {
  const script = await fs.readFile(
    path.join(root, "infra", "deploy", "deploy-catsco-skillhub"),
    "utf8"
  );

  const validation = script.indexOf('if [[ ! -L "${APP_LINK}" ]]');
  assert.notEqual(validation, -1);

  for (const sideEffect of [
    "npm ci --omit=dev",
    'pg_dump "${SKILLHUB_DATABASE_URL}"',
    "node scripts/migrate.js"
  ]) {
    const index = script.indexOf(sideEffect);
    assert.notEqual(index, -1, `missing deployment step: ${sideEffect}`);
    assert.ok(validation < index, `release validation must precede: ${sideEffect}`);
  }
});

test("first-install documentation creates a release-backed app link", async () => {
  const guide = await fs.readFile(
    path.join(root, "docs", "operations", "deployment.md"),
    "utf8"
  );

  assert.match(guide, /releases\/\$\{release_id\}/);
  assert.match(
    guide,
    /ln -s \/opt\/catsco\/skillhub\/releases\/\$\{release_id\} \/opt\/catsco\/skillhub\/app/
  );
  assert.match(guide, /bootstrap-legacy-/);
  assert.doesNotMatch(
    guide,
    /mkdir -p \/opt\/catsco\/skillhub\/\{app,/
  );
});
