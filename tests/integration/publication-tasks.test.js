import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiServer } from '../../apps/api/server.js';
import { loadConfig } from '../../packages/config/index.js';
import { hashSessionToken } from '../../packages/auth/index.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';
import { publicTask } from '../../packages/publication-tasks/store.js';
import { publicationTaskSettings } from '../../packages/publication-tasks/config.js';
import { processPublicationTask } from '../../packages/publication-tasks/worker.js';

const raw = JSON.stringify({ source: { type: 'files', files: [
  { path: 'SKILL.md', content: '---\nname: sample\ndescription: Useful\n---\n# Private content' }
] } });
const digest = value => createHash('sha256').update(value).digest('hex');
const endpoint = '/api/skills/publication-tasks';
const headers = { Cookie: 'catsco_session=alice', 'Content-Type': 'application/json', 'Idempotency-Key': 'request-00001' };

function request(port, route = endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: options.method ?? 'GET', headers: options.headers ?? headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end(options.body);
  });
}

async function withServer(overrides, callback, custom = {}) {
  const rows = new Map();
  const config = loadConfig({ nodeEnv: 'test', publicationTasksEnabled: true, sessionSecret: 'task-tests', agentClientSecret: 'agent-secret', ...overrides });
  const store = {
    getSessionByTokenHash: async hash => hash === hashSessionToken('alice', 'task-tests') ? { userId: 'alice' } : null,
    getUserById: async id => ({ id, status: 'active', displayName: id }), getRoles: async () => ['user'], getDeveloperProfile: async () => null,
    findPublicationTaskForRequest: async () => null,
    createPublicationTask: async input => {
      const task = { id: `pubtask_${randomUUID()}`, state: input.result.status === 200 ? 'queued' : 'rejected', validation: input.result };
      rows.set(task.id, input);
      return { task, created: true };
    },
    listPublicationTasks: async () => [], getPublicationTask: async () => null, cancelPublicationTask: async () => null,
    ...custom
  };
  const server = createApiServer(config, { store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await callback(server.address().port, rows); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('publication tasks are default-off and invalid optional settings do not stop API startup', async () => {
  for (const env of ['production', 'development']) assert.equal(loadConfig({ nodeEnv: env }).publicationTasks.enabled, false);
  for (const overrides of [
    { publicationTasksEnabled: false, publicationTasksLeaseMs: 0 },
    { publicationTasksLeaseMs: 0 }, { publicationTasksMaxTasks: NaN }, { publishValidationMaxConcurrent: 0 },
    { publicationTasksRetentionMs: 1 }
  ]) await withServer(overrides, async port => {
    assert.equal((await request(port)).status, overrides.publicationTasksEnabled === false ? 404 : 503);
    assert.equal((await request(port, '/healthz')).status, 200);
  });
});

test('service bearer and expired sessions cannot create or enumerate tasks', async () => {
  await withServer({}, async port => {
    for (const auth of [{ Authorization: 'Bearer agent-secret' }, { Cookie: 'catsco_session=expired' }, {}]) {
      assert.equal((await request(port, endpoint, { headers: auth, method: 'POST', body: '{invalid' })).status, 401);
      assert.equal((await request(port, endpoint, { headers: auth })).status, 401);
    }
  }, { createPublicationTask: async () => { throw new Error('must not persist unauthenticated input'); } });
});

test('intake persists exact private candidates but never publishes or retains unsafe archive paths', async () => {
  await withServer({}, async (port, rows) => {
    const created = await request(port, endpoint, { method: 'POST', body: raw });
    assert.equal(created.status, 202);
    assert.equal(created.body.task.state, 'queued');
    assert.equal(created.headers['cache-control'], 'no-store');
    const saved = rows.get(created.body.task.id);
    assert.equal(saved.ownerId, 'alice');
    assert.deepEqual(saved.candidate, Buffer.from(raw));
    assert.equal(saved.requestHash, digest(raw));
    const missing = raw.replace('description: Useful\\n', '');
    const rejected = await request(port, endpoint, { method: 'POST', body: missing });
    assert.equal(rejected.status, 201);
    assert.equal(rejected.body.task.state, 'rejected');
    assert.ok(rows.get(rejected.body.task.id).candidate);
    const unsafe = raw.replace('SKILL.md', '../SKILL.md');
    const denied = await request(port, endpoint, { method: 'POST', body: unsafe });
    assert.equal(denied.status, 201);
    assert.equal(rows.get(denied.body.task.id).candidate, null);
    assert.equal(rows.get(denied.body.task.id).candidateHash, null);
    assert.equal(JSON.stringify(denied.body).includes('Private content'), false);
  });
});

test('malformed requests, identity fields and missing idempotency key are rejected without a task', async () => {
  await withServer({}, async (port, rows) => {
    assert.equal((await request(port, endpoint, { method: 'POST', body: '{invalid' })).status, 400);
    assert.equal((await request(port, endpoint, { method: 'POST', body: raw.slice(0,-1) + ',"ownerId":"other"}' })).status, 400);
    assert.equal((await request(port, endpoint, { method: 'POST', body: raw, headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' } })).status, 400);
    assert.equal(rows.size, 0);
    assert.equal((await request(port, `${endpoint}/pubtask_${randomUUID()}`)).status, 404);
    assert.equal((await request(port, `${endpoint}/pubtask_${randomUUID()}/publish`, { method: 'POST' })).status, 404);
  });
});

test('replay returns the prior task without validation/storage and database errors are redacted', async () => {
  const task = { id: `pubtask_${randomUUID()}`, state: 'ready' };
  await withServer({}, async port => {
    const result = await request(port, endpoint, { method: 'POST', body: raw });
    assert.equal(result.status, 200); assert.equal(result.body.replayed, true); assert.deepEqual(result.body.task, task);
  }, { findPublicationTaskForRequest: async () => task, createPublicationTask: async () => { throw new Error('unexpected storage'); } });
  await withServer({}, async port => {
    const result = await request(port);
    assert.equal(result.status, 503); assert.equal(JSON.stringify(result).includes('secret-password'), false);
  }, { listPublicationTasks: async () => { throw new Error('secret-password'); } });
});

test('shared transport errors use task codes and static messages without forwarding private errors', async () => {
  for (const [status, code, expected] of [
    [413, 'request_too_large', 'too_large'],
    [400, 'invalid_request', 'body_invalid'],
    [503, 'unavailable', 'unavailable'],
    [400, 'unknown', 'unavailable'],
    [400, 'request_too_large', 'unavailable']
  ]) {
    await withServer({}, async port => {
      const response = await request(port);
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, `skillhub.publication_task_${expected}`);
      assert.equal(JSON.stringify(response.body).includes('private transport detail'), false);
    }, { listPublicationTasks: async () => {
      throw Object.assign(new Error('private transport detail'), { status, code: `skillhub.publish_validation_${code}` });
    } });
  }
});

test('raw read limits and per-account quotas apply to task routes', async () => {
  await withServer({ publishValidationMaxRequestBytes: 128 }, async port => {
    assert.equal((await request(port, endpoint, { method: 'POST', body: raw })).status, 413);
  });
  await withServer({ publishValidationRequestsPerMinute: 1 }, async port => {
    assert.equal((await request(port)).status, 200);
    assert.equal((await request(port)).status, 429);
  });
});

test('declared and actual chunked overflow return the same task error without storing a task', async () => {
  await withServer({ publishValidationMaxRequestBytes: 1024 }, async (port, rows) => {
    const declared = await request(port, endpoint, { method: 'POST', headers: { ...headers, 'Content-Length': '5000' }, body: 'x'.repeat(5000) });
    const chunked = await request(port, endpoint, { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' }, chunks: ['x'.repeat(2000), 'y'.repeat(2000)] });
    for (const response of [declared, chunked]) {
      assert.equal(response.status, 413);
      assert.equal(response.body.error.code, 'skillhub.publication_task_too_large');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.deepEqual(chunked.body, declared.body);
    assert.equal(rows.size, 0);
    assert.equal((await request(port, endpoint, { method: 'POST', body: raw })).status, 202);
  });
});

function taskRow() {
  const result = validatePublishRequest(raw);
  return { id: `pubtask_${randomUUID()}`, owner_user_id: 'alice', candidate: Buffer.from(raw), candidate_bytes: Buffer.byteLength(raw),
    request_hash: digest(raw), candidate_hash: result.body.validation.candidateHash, attempts: 1, lease_token: 'internal-token',
    state: 'queued', intake_result: result, created_at: new Date(), updated_at: new Date(), expires_at: new Date(Date.now()+10000), purge_after: new Date(Date.now()+20000) };
}

test('public task projection excludes private bytes, request keys and lease identity', () => {
  const row = taskRow();
  const projection = publicTask(row);
  assert.equal(projection.capabilities.publish, false);
  assert.equal(projection.capabilities.repair, false);
  for (const text of ['Private content', 'internal-token', 'owner_user_id', 'request_hash']) assert.equal(JSON.stringify(projection).includes(text), false);
  const expired = publicTask(row, Date.now()+11000);
  assert.equal(expired.state, 'expired'); assert.equal(expired.candidateAvailable, false);
});

test('worker revalidates saved bytes, rejects tampering/inactive owner and never uses publication machinery', async () => {
  for (const kind of ['valid','tampered','inactive','timeout','changed-hash']) {
    const row = taskRow(), outcomes = [];
    if (kind === 'tampered') row.candidate = Buffer.from('changed');
    const config = loadConfig({ publicationTasksEnabled: true });
    const store = { claimPublicationTask: async () => row,
      getUserById: async () => ({ status: kind === 'inactive' ? 'disabled' : 'active' }),
      finishPublicationTask: async (_row, outcome) => { outcomes.push(outcome); return false; } };
    await processPublicationTask(config, { store, validate: async candidate => {
      assert.deepEqual(candidate, Buffer.from(raw));
      if (kind === 'timeout') throw new Error('private upstream exception');
      const result = validatePublishRequest(candidate.toString());
      if (kind === 'changed-hash') result.body.validation.candidateHash = 'changed';
      return result;
    } });
    assert.equal(outcomes.length, 1);
    if (kind === 'valid') assert.equal(outcomes[0].result.status, 200);
    else if (kind === 'timeout') assert.equal(outcomes[0].retry, true);
    else assert.match(outcomes[0].errorCode, kind === 'inactive' ? /owner_inactive/ : /candidate_changed/);
    assert.equal(JSON.stringify(outcomes).includes('private upstream exception'), false);
  }
});

test('disabled or invalid optional task worker never accesses persistence', async () => {
  const store = new Proxy({}, { get() { throw new Error('unexpected store access'); } });
  assert.equal(await processPublicationTask(loadConfig({ publicationTasksEnabled: false }), { store }), null);
  assert.equal(await processPublicationTask(loadConfig({ publicationTasksEnabled: true, publicationTasksLeaseMs: 1 }), { store }), null);
  assert.throws(() => publicationTaskSettings(loadConfig({ publicationTasksEnabled: true, publicationTasksRetentionMs: 1 })));
});

test('timed out authentication and database operations retain admission until their real settlement', async () => {
  for (const phase of ['auth','database']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let block = true;
    const custom = phase === 'auth'
      ? { getSessionByTokenHash: async () => { if (block) await gate; return { userId:'alice' }; } }
      : { listPublicationTasks: async () => { if (block) await gate; return []; } };
    await withServer({ publishValidationMaxConcurrent:1,publishValidationReadTimeoutMs:30,publishValidationWorkerTimeoutMs:30 }, async port => {
      try {
        const timedOut = await request(port);
        assert.equal(timedOut.status,503);
        assert.equal(timedOut.body.error.code, 'skillhub.publication_task_unavailable');
        const second = await request(port);
        assert.equal(second.status,503); assert.match(second.body.error.code,/busy/);
      } finally { block=false; release(); }
      await delay(10);
      assert.equal((await request(port)).status,200);
    },custom);
  }
});

test('disconnect during body read prevents persistence and releases its admission slot', async () => {
  await withServer({ publishValidationMaxConcurrent:1 }, async (port, rows) => {
    const req = http.request({host:'127.0.0.1',port,path:endpoint,method:'POST',headers});
    req.on('error',()=>{}); req.write('{');
    await delay(20);
    assert.equal((await request(port)).status,503);
    req.destroy();
    let response;
    for (let i=0;i<20;i++) { await delay(5); response=await request(port); if(response.status===200) break; }
    assert.equal(response.status,200); assert.equal(rows.size,0);
  });
});

test('disconnect after storage starts cannot create a second task when the response is lost', async () => {
  let started, release, saved=null, writes=0;
  const entered = new Promise(resolve=>{started=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  await withServer({publishValidationMaxConcurrent:1}, async port => {
    const req=http.request({host:'127.0.0.1',port,path:endpoint,method:'POST',headers});
    req.on('error',()=>{}); req.end(raw);
    try {
      await entered; req.destroy();
      assert.equal((await request(port)).status,503);
    } finally { release(); }
    await delay(10);
    const replay=await request(port,endpoint,{method:'POST',body:raw});
    assert.equal(replay.status,200); assert.equal(replay.body.replayed,true);
    assert.equal(replay.body.task.id,saved.id); assert.equal(writes,1);
  },{
    findPublicationTaskForRequest:async()=>saved,
    createPublicationTask:async()=>{
      writes++; started(); await gate;
      saved={id:`pubtask_${randomUUID()}`,state:'queued'};
      return {task:saved,created:true};
    }
  });
});
