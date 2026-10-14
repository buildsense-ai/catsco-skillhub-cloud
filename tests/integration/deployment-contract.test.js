import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import os from "node:os";

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

test("deployment bounds manager calls and probes before migration and release switching", async () => {
  const script = await fs.readFile(path.join(root, "infra/deploy/deploy-catsco-skillhub"), "utf8");
  const firstGuard = script.indexOf('\nrequire_service_manager\n');
  assert.ok(firstGuard > 0);
  for (const step of ['npm ci --omit=dev', 'node scripts/migrate.js', 'mv -Tf "${NEXT_LINK}" "${APP_LINK}"']) {
    assert.ok(firstGuard < script.indexOf(step), `manager check must precede ${step}`);
  }
  assert.match(script, /require_service_manager\nmv -Tf/);
  for (const line of script.split('\n').filter(line => /systemctl (restart|reload|is-active|show)/.test(line))) {
    assert.match(line, /timeout --kill-after=/, `unbounded manager call: ${line}`);
  }
  assert.match(script, /timeout --kill-after=2s 90s bash -c/);
  assert.match(script, /curl --connect-timeout 2 --max-time 5/);
  assert.match(script, /runtime recovery is UNVERIFIED/);
});

test("deployment manager/health guards run against responsive, frozen and failing probes", async t => {
  const script = await fs.readFile(path.join(root, "infra/deploy/deploy-catsco-skillhub"), "utf8");
  const functions = script.slice(script.indexOf('require_service_manager() {'), script.indexOf('rollback_on_error() {'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const fixtureBin = await fs.mkdtemp(path.join(os.tmpdir(), 'skillhub-deploy-'));
  t.after(() => fs.rm(fixtureBin, { recursive: true, force: true }));
  // timeout execs a program, not a shell function. This fixture executable
  // delegates to the exported function in its new bash process.
  await fs.writeFile(path.join(fixtureBin, 'systemctl'), '#!/usr/bin/env bash\nsystemctl "$@"\n', { mode: 0o755 });
  const run = (fixture, command, timeout = 15000) => spawnSync(bash, ['-c', `
    set -euo pipefail
    export PATH="${process.platform === 'win32' ? '$(cygpath -u "$FIXTURE_BIN")' : '$FIXTURE_BIN'}:$PATH"
    API_SERVICE=fixture-api
    WORKER_SERVICE=fixture-worker
    ${functions}
    ${fixture}
    export -f systemctl
    ${command}
  `], { encoding: 'utf8', timeout, env: { ...process.env, FIXTURE_BIN: fixtureBin } });
  // Degraded hosts may still have a responsive PID 1; no is-system-running gate.
  const healthy = `systemctl() { if [[ "$1" == show ]]; then echo 255.4; else return 0; fi; }
    curl() { return 0; }; export -f curl`;
  let result = run(healthy, 'require_service_manager; wait_for_health');
  assert.equal(result.status, 0, result.stderr);
  result = run('systemctl() { return 1; }', 'require_service_manager');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Service manager is unresponsive/);
  result = run('systemctl() { return 0; }', 'require_service_manager');
  assert.equal(result.status, 1, 'empty manager response must fail closed');
  result = run('systemctl() { sleep 20; }', 'require_service_manager');
  assert.equal(result.error, undefined, 'guard must finish before the test timeout');
  assert.equal(result.status, 1, result.stderr);
  result = run(`${healthy}
    curl() { return 22; }; sleep() { :; }; export -f curl sleep`, 'wait_for_health');
  assert.equal(result.status, 1, 'failed HTTP probes must not pass health checks');
});

test("rollback restores the link but reports unverified recovery when PID 1 is frozen", async () => {
  const script = await fs.readFile(path.join(root, "infra/deploy/deploy-catsco-skillhub"), "utf8");
  const rollback = script.slice(script.indexOf('rollback_on_error() {'), script.indexOf('trap rollback_on_error ERR'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const result = spawnSync(bash, ['-c', `
    ${rollback}
    nginx_switched=0; switched=1; previous_release=fixture-old
    INCOMING_PATH=fixture-incoming; NEXT_LINK=fixture-next; ROLLBACK_LINK=fixture-rollback; APP_LINK=fixture-app
    rm() { :; }; ln() { :; }; mv() { echo link-restored; }
    require_service_manager() { return 1; }
    timeout() { echo unexpected-restart; return 1; }
    wait_for_health() { echo unexpected-polling; return 1; }
    (exit 7)
    rollback_on_error
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 7, 'preserve the original deployment failure');
  assert.match(result.stdout, /link-restored/);
  assert.doesNotMatch(result.stdout, /unexpected-/);
  assert.match(result.stderr, /runtime recovery is UNVERIFIED/);
});
