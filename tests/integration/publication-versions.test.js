import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { after, afterEach, before, test } from 'node:test';
import { createStore, closePools } from '../../packages/database/store.js';
import { loadConfig } from '../../packages/config/index.js';
import { nextAvailablePublicVersion, comparePublicVersions } from '../../packages/publication-tasks/versions.js';
import { createApiServer } from '../../apps/api/server.js';
import { hashSessionToken } from '../../packages/auth/index.js';
import { processJobs } from '../../packages/queue/index.js';
import { ensureRootKey } from '../../packages/signing/index.js';

test('public version allocation includes reservations and uses exact integer arithmetic', () => {
  assert.equal(nextAvailablePublicVersion('1.0.0', []), '1.0.0');
  assert.equal(nextAvailablePublicVersion('1.0.0', ['1.0.9','2.0.0','1.0.10']), '2.0.1');
  assert.equal(nextAvailablePublicVersion('3.0.0', ['2.0.0']), '3.0.0');
  assert.equal(nextAvailablePublicVersion('1.0.0', ['1.0.9007199254740992']), '1.0.9007199254740993');
  assert.equal(comparePublicVersions('1.0.9007199254740993','1.0.9007199254740992'), 1);
  assert.equal(nextAvailablePublicVersion('1.0.0', ['1.0.01']), '1.0.2');
  assert.equal(nextAvailablePublicVersion('1.0.0', ['1.0.0-beta']), '1.0.1');
  assert.throws(() => nextAvailablePublicVersion('1.0.0', [null]), { status: 409 });
});

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;
const pg = { skip: !databaseUrl };
let store, config, root;
const fixtures = [];
before(async () => {
  if (!databaseUrl) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillhub-versions-'));
  config = loadConfig({ databaseUrl, root, storageRoot: path.join(root,'storage'),
    sharedRoot: path.join(root,'shared'), logsRoot: path.join(root,'logs'), nodeEnv: 'test',
    sessionSecret: 'version-test-only', allowAutoKeygen: true });
  store = createStore(config);
  await ensureRootKey(config);
});
afterEach(async () => {
  if (!store) return;
  for (const f of fixtures.splice(0)) {
    await store.query("DELETE FROM jobs WHERE payload->'manifest'->>'id'=$1", [f.skillId]);
    await store.query('DELETE FROM publication_version_reservations WHERE skill_id=$1', [f.skillId]);
    await store.query('DELETE FROM skill_versions WHERE skill_id=$1', [f.skillId]);
    await store.query('DELETE FROM skill_scans WHERE skill_id=$1', [f.skillId]);
    await store.query('DELETE FROM skills WHERE id=$1', [f.skillId]);
    await store.query('DELETE FROM users WHERE id=$1', [f.ownerId]);
  }
});
after(async () => { await closePools(); if (root) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const ownerId = `version-${randomUUID()}`;
  const skillId = `${ownerId}/fixture`;
  await store.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ($1,$2,'fixture',$1)", [ownerId, `${ownerId}@example.invalid`]);
  const f = { ownerId, skillId, uploadId: `upl_${randomUUID()}`, version: '1.0.0' };
  fixtures.push(f); return f;
}
async function job(f, status='queued') {
  const saved = await store.enqueueJob('publish_skill_version', {
    uploadId: f.uploadId, manifest: { id: f.skillId, version: f.version }, publisher: { userId: f.ownerId }
  });
  await store.query('UPDATE jobs SET status=$2 WHERE id=$1', [saved.id, status]);
  return saved;
}

test('PostgreSQL concurrent reservations allocate unique versions and replay the same upload', pg, async () => {
  const f = await fixture();
  const replay = await Promise.all(Array.from({length:5}, () => store.reservePublicVersion(f)));
  assert.deepEqual(replay.map(r => r.version), Array(5).fill('1.0.0'));
  const parallel = await Promise.all(Array.from({length:5}, () => store.reservePublicVersion({ ...f, uploadId: `upl_${randomUUID()}` })));
  assert.deepEqual(parallel.map(r => r.version).sort(), ['1.0.1','1.0.2','1.0.3','1.0.4','1.0.5']);
  await assert.rejects(store.reservePublicVersion({ ...f, ownerId:'other' }), { status:409 });
  await assert.rejects(store.reservePublicVersion({ ...f, version:'9.0.0' }), { status:409 });
  await assert.rejects(store.reservePublicVersion({ ...f, uploadId:'different', ownerId:'other' }), { status:409 });
});

test('PostgreSQL legacy queued/running/failed jobs and abandoned reservations occupy versions', pg, async () => {
  const f = await fixture();
  for (const [i,status] of ['queued','running','failed'].entries()) {
    await job({ ...f, uploadId:`upl_${randomUUID()}`, version:`1.0.${i}` }, status);
  }
  const r = await store.reservePublicVersion(f);
  assert.equal(r.version, '1.0.3');
  assert.equal((await store.reservePublicVersion({ ...f, uploadId:`upl_${randomUUID()}` })).version, '1.0.4');
});

test('PostgreSQL old jobs adopt exact slots; collisions fail instead of renumbering or overwriting', pg, async () => {
  const f = await fixture();
  await job(f);
  const other = { ...f, uploadId:`upl_${randomUUID()}` };
  await job(other);
  await assert.rejects(store.adoptPublicVersion(other), { status:409 });
  assert.equal((await store.adoptPublicVersion(f)).version, '1.0.0');
  assert.equal((await store.adoptPublicVersion(f)).version, '1.0.0');
  await assert.rejects(store.adoptPublicVersion({ ...f, version:'1.0.1' }), { status:409 });
});

test('PostgreSQL owner of an existing skill cannot be replaced by a reservation', pg, async () => {
  const f = await fixture();
  await store.query("INSERT INTO skills (id,name,display_name,owner_user_id,visibility_scope) VALUES ($1,'fixture','Fixture',$2,'private')", [f.skillId, f.ownerId]);
  await assert.rejects(store.reservePublicVersion({ ...f, ownerId:'other' }), { status:409 });
  await store.reservePublicVersion(f);
  assert.equal((await store.query('SELECT visibility_scope FROM skills WHERE id=$1', [f.skillId])).rows[0].visibility_scope, 'private');
});

test('PostgreSQL package commit rechecks slots, preserves visibility and is checksum-idempotent', pg, async () => {
  const f = await fixture();
  await store.query("INSERT INTO skills (id,name,display_name,owner_user_id,visibility_scope) VALUES ($1,'fixture','Fixture',$2,'private')", [f.skillId,f.ownerId]);
  await store.reservePublicVersion(f);
  const submission = { id:f.uploadId, submitterId:f.ownerId };
  const pkg = { id:`pkg_${randomUUID()}`, skillId:f.skillId, skillName:'fixture', displayName:'Fixture',
    version:f.version, status:'published', packagePath:'/fixture', packageFile:'fixture', packageUrl:'https://example.invalid/fixture',
    packageSize:1, checksumSha256:'fixture-checksum', payloadSha256:'fixture-payload', contentHash:'fixture-content',
    signature:{}, manifest:{id:f.skillId,version:f.version}, submissionId:f.uploadId, scanRunId:null, publishedAt:new Date().toISOString() };
  await assert.rejects(store.createPackageVersion(pkg, { ...submission, id:'other-upload' }), { status:409 });
  await store.createPackageVersion(pkg, submission);
  assert.equal((await store.createPackageVersion(pkg, submission)).id, pkg.id);
  await assert.rejects(store.createPackageVersion({ ...pkg, checksumSha256:'different' }, submission), { status:409 });
  assert.equal((await store.query('SELECT visibility_scope FROM skills WHERE id=$1',[f.skillId])).rows[0].visibility_scope,'private');
  await store.yankPackageVersion(pkg.id);
  assert.equal((await store.createPackageVersion(pkg, submission)).status,'yanked');
  assert.equal((await store.query('SELECT count(*)::int AS n FROM skill_versions WHERE skill_id=$1',[f.skillId])).rows[0].n,1);
});

test('PostgreSQL concurrent HTTP shares embed reserved versions and worker replay does not revive yanked releases', pg, async () => {
  const f = await fixture(), token = randomUUID();
  await store.createSession({ userId:f.ownerId, tokenHash:hashSessionToken(token,config.session.secret), expiresAt:new Date(Date.now()+60000).toISOString() });
  const server = createApiServer(config, { store });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const share = content => new Promise((resolve,reject) => {
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/skills/share',method:'POST',
      headers:{Cookie:`${config.session.cookieName}=${token}`,'Content-Type':'application/json'}}, res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
    });
    req.on('error',reject);
    req.end(JSON.stringify({manifest:{name:'fixture',displayName:'Fixture',version:'1.0.0',description:'Test version allocation'},
      source:{type:'files',files:[{path:'SKILL.md',content:`---\nname: fixture\ndescription: Test\n---\n${content}`}]},confirmVersionPublish:true}));
  });
  try {
    const results = await Promise.all([share('first'),share('second')]);
    assert.deepEqual(results.map(r=>r.status), [201,201], JSON.stringify(results));
    assert.equal(results[0].body.upload.skillId, f.skillId);
    assert.deepEqual(results.map(r=>r.body.upload.version).sort(), ['1.0.0','1.0.1']);
    for (const r of results) assert.equal(r.body.skillHub.version,r.body.upload.version);
    // Deliberately complete the newer job first. latest_version must not regress.
    await store.query("UPDATE jobs SET created_at=now()-interval '1 hour' WHERE payload->'manifest'->>'id'=$1 AND payload->'manifest'->>'version'='1.0.1'", [f.skillId]);
    const processed = await processJobs(config);
    assert.ok(processed.length >= 2);
    assert.equal(processed.every(r=>r.status==='succeeded'), true, processed.map(r=>r.error?.message).join(';'));
    assert.equal((await store.query('SELECT latest_version FROM skills WHERE id=$1',[f.skillId])).rows[0].latest_version,'1.0.1');
    const published = await store.findPackageBySkillVersion(f.skillId,'1.0.0');
    const pkg = JSON.parse(await fs.readFile(published.packagePath,'utf8'));
    assert.equal(pkg.payload.manifest.version,'1.0.0');
    assert.match(Buffer.from(pkg.payload.files.find(v=>v.path==='SKILL.md').contentBase64,'base64').toString(), /1\.0\.0/);
    await store.yankPackageVersion(published.id);
    await store.query("UPDATE jobs SET status='queued',run_after=now() WHERE payload->'manifest'->>'id'=$1",[f.skillId]);
    assert.equal((await processJobs(config)).every(r=>r.status==='succeeded'),true);
    assert.equal((await store.findPackageBySkillVersion(f.skillId,'1.0.0')).status,'yanked');
    assert.equal((await store.query('SELECT count(*)::int AS n FROM skill_versions WHERE skill_id=$1',[f.skillId])).rows[0].n,2);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
