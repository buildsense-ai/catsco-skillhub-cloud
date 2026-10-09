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

test("production deploy applies the release Nginx ACL proxy and rolls it back on failure", async () => {
  const script = await fs.readFile(
    path.join(root, "infra", "deploy", "deploy-catsco-skillhub"),
    "utf8"
  );

  assert.match(script, /infra\/nginx\/skillhub\.conf/);
  assert.match(script, /nginx -t/);
  assert.match(script, /systemctl reload nginx/);
  assert.match(script, /pre-deploy-\$\{RELEASE_ID\}\.nginx\.conf/);
  assert.match(script, /restoring the previous Nginx configuration/);
  const missingConfigGuard = script.slice(
    script.indexOf('Release is missing infra/nginx/skillhub.conf.'),
    script.indexOf('cp -p -- "${NGINX_CONFIG_PATH}"', script.indexOf('Release is missing infra/nginx/skillhub.conf.'))
  );
  assert.match(missingConfigGuard, /false/);
  assert.doesNotMatch(missingConfigGuard, /exit 4/);
  assert.ok(
    script.indexOf("wait_for_health") < script.lastIndexOf("nginx -t"),
    "Nginx must be switched only after the new API is healthy"
  );
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

test("legacy bootstrap creates a missing releases directory before stopping services", async () => {
  const guide = await fs.readFile(
    path.join(root, "docs", "operations", "deployment.md"),
    "utf8"
  );
  const bootstrapStart = guide.indexOf('release_id="bootstrap-legacy-');
  const bootstrapEnd = guide.indexOf("bootstrap 只调整源码目录布局", bootstrapStart);
  assert.notEqual(bootstrapStart, -1);
  assert.notEqual(bootstrapEnd, -1);

  const bootstrap = guide.slice(bootstrapStart, bootstrapEnd);
  const createReleases = bootstrap.indexOf(
    'sudo install -d -o root -g skillhub -m 0750 "${root}/releases"'
  );
  const stopServices = bootstrap.indexOf("sudo systemctl stop");
  const moveApp = bootstrap.indexOf(
    'sudo mv "${root}/app" "${root}/releases/${release_id}"'
  );

  assert.notEqual(createReleases, -1);
  assert.notEqual(stopServices, -1);
  assert.notEqual(moveApp, -1);
  assert.ok(createReleases < stopServices);
  assert.ok(createReleases < moveApp);
});

test("database migrations recover from transient connection termination", async () => {
  const script = await fs.readFile(
    path.join(root, "scripts", "migrate.js"),
    "utf8"
  );

  assert.match(script, /client\.on\("error"/);
  assert.match(script, /SKILLHUB_MIGRATION_RETRIES/);
  assert.match(script, /isRetryableConnectionError/);
  assert.match(script, /await closePools\(\)\.catch/);
});
