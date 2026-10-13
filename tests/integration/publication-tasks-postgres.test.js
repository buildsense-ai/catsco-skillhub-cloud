import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, afterEach, before, test } from 'node:test';
import { createApiServer } from '../../apps/api/server.js';
import { loadConfig } from '../../packages/config/index.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { hashSessionToken } from '../../packages/auth/index.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import { processPublicationTask } from '../../packages/publication-tasks/worker.js';

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;
const pg = { skip: !databaseUrl };
const raw = Buffer.from(JSON.stringify({ source: { type: 'files', files: [{ path: 'SKILL.md', content: '---\nname: task-fixture\ndescription: Only fixture\n---\nContent' }] } }));
const result = validatePublishRequest(raw.toString());
const digest = value => createHash('sha256').update(value).digest('hex');
let config, settings, store;
const users = [];
before(() => {
  if (!databaseUrl) return;
  config = loadConfig({ databaseUrl, nodeEnv: 'test', publicationTasksEnabled: true, sessionSecret: 'publication-pg-test' });
  settings = publicationTaskSettings(config);
  store = createStore(config);
});
afterEach(async () => {
  if (store && users.length) await store.query('DELETE FROM users WHERE id=ANY($1::text[])', [users.splice(0)]);
});
after(async () => { await closePools(); });

async function owner() {
  const id = `publication-test-${randomUUID()}`;
  await store.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'fixture-only','Task fixture')`, [id, `${id}@example.invalid`]);
  users.push(id);
  return id;
}
async function create(ownerId, overrides = {}) {
  return store.createPublicationTask({ ownerId, requestKey: randomUUID(), requestHash: digest(raw),
    candidateHash: result.body.validation.candidateHash, candidate: raw, result, settings, ...overrides });
}
async function expireLease(task) {
  await store.query("UPDATE publication_tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [task.id]);
}

test('PostgreSQL owner-scoped task creation is atomic/idempotent and rejects differing exact input', pg, async () => {
  const a = await owner(), b = await owner(), requestKey = randomUUID();
  const responses = await Promise.all(Array.from({ length: 5 }, () => create(a, { requestKey })));
  assert.equal(new Set(responses.map(r => r.task.id)).size, 1);
  assert.equal(responses.filter(r => r.created).length, 1);
  const first = responses[0].task;
  await assert.rejects(create(a, { requestKey, requestHash: digest('different explicit manifest') }), { status: 409 });
  assert.notEqual((await create(b, { requestKey })).task.id, first.id);
  assert.equal(await store.getPublicationTask(b, first.id), null);
  assert.equal(await store.cancelPublicationTask(b, first.id), null);
  const saved = await store.query('SELECT candidate FROM publication_tasks WHERE id=$1', [first.id]);
  assert.deepEqual(saved.rows[0].candidate, raw);
  assert.equal((await store.listPublicationTasks(a))[0].validation, undefined);
});

test('PostgreSQL validation completes without creating any legacy job, package or skill', pg, async () => {
  const a = await owner();
  const count = async () => (await store.query('SELECT (SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM skills) AS skills,(SELECT count(*) FROM skill_versions) AS versions')).rows[0];
  const before = await count();
  const created = await create(a);
  await processPublicationTask(config, { store });
  const ready = await store.getPublicationTask(a, created.task.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.validation.body.validation.candidateHash, created.task.candidateHash);
  assert.deepEqual(ready.capabilities, { publish: false, repair: false });
  assert.deepEqual(await count(), before);
});

test('PostgreSQL double workers cannot claim the same task; expired leases fence stale completions', pg, async () => {
  const a = await owner();
  await create(a);
  const claims = await Promise.all([store.claimPublicationTask(settings), store.claimPublicationTask(settings)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean);
  await expireLease(first);
  assert.equal(await store.finishPublicationTask(first, { result }), false);
  const second = await store.claimPublicationTask(settings);
  assert.equal(second.id, first.id); assert.notEqual(second.lease_token, first.lease_token);
  assert.equal(await store.finishPublicationTask(first, { result }), false);
  assert.equal(await store.finishPublicationTask(second, { result }), true);
  assert.equal((await store.getPublicationTask(a, first.id)).state, 'ready');
});

test('PostgreSQL cancellation erases candidate and prevents a running worker from restoring the task', pg, async () => {
  const a = await owner();
  const created = await create(a);
  const claim = await store.claimPublicationTask(settings);
  assert.equal((await store.cancelPublicationTask(a, created.task.id)).state, 'cancelled');
  assert.equal(await store.finishPublicationTask(claim, { result }), false);
  const row = (await store.query('SELECT candidate,candidate_bytes FROM publication_tasks WHERE id=$1', [claim.id])).rows[0];
  assert.equal(row.candidate, null); assert.equal(Number(row.candidate_bytes), 0);
  assert.equal((await store.cancelPublicationTask(a, claim.id)).state, 'cancelled');
  assert.equal(await store.claimPublicationTask(settings), null);
});

test('PostgreSQL inactive owner is checked at execution and completion', pg, async () => {
  const a = await owner();
  const created = await create(a);
  const claim = await store.claimPublicationTask(settings);
  await store.query("UPDATE users SET status='disabled' WHERE id=$1", [a]);
  assert.equal(await store.finishPublicationTask(claim, { result }), true);
  const row = await store.getPublicationTask(a, created.task.id);
  assert.equal(row.state, 'failed'); assert.match(row.errorCode, /owner_inactive/);
  await assert.rejects(create(a), { status: 403 });
});

test('PostgreSQL candidate tampering fails closed without retrying forever', pg, async () => {
  const a = await owner();
  const created = await create(a);
  const changed = Buffer.from('tampered');
  await store.query('UPDATE publication_tasks SET candidate=$2,candidate_bytes=$3 WHERE id=$1', [created.task.id, changed, changed.length]);
  await processPublicationTask(config, { store });
  const task = await store.getPublicationTask(a, created.task.id);
  assert.equal(task.state, 'failed'); assert.match(task.errorCode, /candidate_changed/);
});

test('PostgreSQL repeated worker loss exhausts three attempts and no stale worker can write', pg, async () => {
  const a = await owner();
  const created = await create(a);
  const claims = [];
  for (let i=0;i<3;i++) {
    const claim = await store.claimPublicationTask(settings);
    assert.equal(claim.attempts, i+1); claims.push(claim); await expireLease(claim);
  }
  assert.equal(await store.claimPublicationTask(settings), null);
  const task = await store.getPublicationTask(a, created.task.id);
  assert.equal(task.state, 'failed'); assert.match(task.errorCode, /attempts_exhausted/);
  for (const claim of claims) assert.equal(await store.finishPublicationTask(claim, { result }), false);
});

test('PostgreSQL transient validation failures have backoff and bounded retry', pg, async () => {
  const a = await owner();
  const created = await create(a);
  for (let i=0;i<3;i++) {
    await processPublicationTask(config, { store, validate: async () => { throw new Error('secret failure'); } });
    const task = await store.getPublicationTask(a, created.task.id);
    assert.equal(task.state, i===2 ? 'failed' : 'queued');
    assert.equal(JSON.stringify(task).includes('secret failure'), false);
    assert.equal(await store.claimPublicationTask(settings), null);
    await store.query("UPDATE publication_tasks SET run_after=now()-interval '1 second' WHERE id=$1", [task.id]);
  }
});

test('PostgreSQL account count and byte budgets remain bounded under concurrent intake', pg, async () => {
  const a = await owner();
  const small = { ...settings, maxTasksPerOwner: 1 };
  const values = await Promise.allSettled([create(a, { settings: small }), create(a, { settings: small })]);
  assert.equal(values.filter(v => v.status==='fulfilled').length, 1);
  assert.equal(values.find(v => v.status==='rejected').reason.status, 429);
  const b = await owner();
  await assert.rejects(create(b, { settings: { ...settings, maxStoredBytesPerOwner: raw.length-1 } }), { status: 429 });
  await assert.rejects(create(b, { settings: { ...settings, maxStoredBytes: raw.length } }), { status: 429 });
});

test('PostgreSQL expiry fences workers, clears raw candidate, and preserves idempotency until retention ends', pg, async () => {
  const a = await owner(), requestKey = randomUUID();
  const created = await create(a, { requestKey });
  const claim = await store.claimPublicationTask(settings);
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [claim.id]);
  assert.equal((await store.getPublicationTask(a, claim.id)).state, 'expired');
  assert.equal(await store.finishPublicationTask(claim, { result }), false);
  await store.maintainPublicationTasks();
  assert.equal((await store.query('SELECT candidate FROM publication_tasks WHERE id=$1', [claim.id])).rows[0].candidate, null);
  const replay = await create(a, { requestKey });
  assert.equal(replay.created, false); assert.equal(replay.task.id, created.task.id); assert.equal(replay.task.state, 'expired');
  await store.query("UPDATE publication_tasks SET expires_at=now()-interval '2 seconds',purge_after=now()-interval '1 second' WHERE id=$1", [claim.id]);
  await store.maintainPublicationTasks();
  assert.equal(await store.getPublicationTask(a, claim.id), null);
});

test('PostgreSQL HTTP task survives server recreation and logout does not undo accepted validation work', pg, async () => {
  const a = await owner();
  const token = randomUUID(), key = randomUUID();
  await store.createSession({ userId: a, tokenHash: hashSessionToken(token, config.session.secret), expiresAt: new Date(Date.now()+60000).toISOString() });
  const api = async callback => {
    const server = createApiServer(config, { store });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const call = (method, route, body) => new Promise((resolve,reject) => {
      const req = http.request({ host:'127.0.0.1',port:server.address().port,path:route,method,headers:{Cookie:`${config.session.cookieName}=${token}`,'Content-Type':'application/json','Idempotency-Key':key}}, res=>{
        const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
      }); req.on('error',reject); req.end(body);
    });
    try { return await callback(call); } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  };
  const first = await api(call=>call('POST','/api/skills/publication-tasks',raw));
  assert.equal(first.status,202);
  const again = await api(call=>call('POST','/api/skills/publication-tasks',raw));
  assert.equal(again.status,200); assert.equal(again.body.task.id,first.body.task.id);
  await store.revokeSession(hashSessionToken(token, config.session.secret));
  await processPublicationTask(config,{store});
  assert.equal((await store.getPublicationTask(a,first.body.task.id)).state,'ready');
  assert.equal((await api(call=>call('GET',`/api/skills/publication-tasks/${first.body.task.id}`))).status,401);
});
