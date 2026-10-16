import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPublicationIntrospectionClient } from '../../packages/publication-delegation/introspection.js';
import { validatePublishRequest } from '../../packages/publish-validation/index.js';

test('Cloud client and pinned CatsCo peer handler exchange actual HTTPS with strict authority binding', { timeout: 180000 }, async t => {
  assert.ok(process.env.CATSCO_CONTRACT_ROOT, 'CATSCO_CONTRACT_ROOT is required; missing counterpart is not a skip');
  const root = path.resolve(process.env.CATSCO_CONTRACT_ROOT);
  assert.ok((await stat(path.join(root, 'go.mod'))).isFile());
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.env.CATSCO_CONTRACT_REVISION) assert.equal(revision, process.env.CATSCO_CONTRACT_REVISION);
  t.diagnostic(`CatsCo counterpart ${revision}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'skillhub-peer-contract-'));
  let child, closed, lines;
  t.after(async () => {
    lines?.close();
    if (child) {
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 5000);
      await closed; clearTimeout(killer);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const binary = path.join(dir, process.platform === 'win32' ? 'peer.exe' : 'peer');
  execFileSync('go', ['build', '-mod=readonly', '-o', binary, fileURLToPath(new URL('./catsco-peer/main.go', import.meta.url))],
    { cwd: root, env: { ...process.env, GOWORK: 'off' }, stdio: 'pipe', timeout: 150000 });
  const raw = Buffer.from(JSON.stringify({ source: { type: 'files', files: [{ path: 'SKILL.md',
    content: '---\nname: contract\ndescription: Synthetic test\n---\n# Private test content' }] } }));
  const validation = validatePublishRequest(raw.toString());
  assert.equal(validation.status, 200);
  const sourceHash = validation.body.validation.candidateHash;
  child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env,
    PEER_TEST_BYTES: String(raw.length), PEER_TEST_HASH: createHash('sha256').update(raw).digest('hex'), PEER_TEST_SOURCE_HASH: sourceHash } });
  let stderr = '';
  child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4096); });
  closed = new Promise(resolve => { child.once('close', resolve); });
  lines = createInterface({ input: child.stdout });
  const startup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Peer fixture startup timeout')), 10000);
    lines.once('line', line => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch { reject(new Error('Peer fixture invalid startup')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Peer fixture exited ${code}: ${stderr}`)); });
  });
  const config = { enabled: true, issuer: startup.origin, audience: 'https://hub.example', peerSecret: '1'.repeat(64) };
  const transport = { requestImpl: (url, options, callback) => https.request(url, { ...options, ca: startup.ca }, callback) };
  const client = createPublicationIntrospectionClient(config, transport);
  const input = { token: 'pubupload_' + '2'.repeat(64), entryRequestId: 'pubentry_' + '3'.repeat(32), authorityEpoch: 1,
    rawBody: raw, sourceSnapshotHash: sourceHash, idempotencyKey: 'pubcandidate_' + '5'.repeat(32) };
  const checkError = (kind) => error => error.code === `skillhub.publication_authority_${kind}`;
  const grant = await client.checkUploadGrant(input);
  assert.equal(grant.actorCatsCoUid, '9223372036854775806');
  assert.equal(grant.botUid, '42');
  assert.equal(grant.sourceSnapshotHash, sourceHash);
  assert.equal(grant.requestHash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(grant.requestBytes, raw.length);
  assert.ok(!JSON.stringify(grant).includes('private-'));
  // Each call goes through the real handler; no mock JSON response on Cloud.
  await assert.rejects(client.checkUploadGrant({ ...input, authorityEpoch: 2 }), checkError('inactive'));
  await assert.rejects(client.checkUploadGrant({ ...input, rawBody: Buffer.concat([raw, Buffer.from(' ')]) }), checkError('inactive'));
  await assert.rejects(client.checkUploadGrant({ ...input, token: 'pubupload_' + 'f'.repeat(64) }), checkError('inactive'));
  // Fifth authorized check uses the stable grant but mismatched Cloud key.
  await assert.rejects(client.checkUploadGrant({ ...input, idempotencyKey: 'pubcandidate_' + 'f'.repeat(32) }), checkError('unavailable'));
  await assert.rejects(createPublicationIntrospectionClient({ ...config, peerSecret: 'e'.repeat(64) }, transport).checkUploadGrant(input), checkError('unavailable'));
  await assert.rejects(createPublicationIntrospectionClient(config).checkUploadGrant(input), checkError('unavailable'));
});
