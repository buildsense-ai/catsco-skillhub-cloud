import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, test } from 'node:test';
import { requireCatsCoIssuer, assertCatsCoIssuerMatches } from '../../packages/publication-delegation/identity.js';
import { createStore, closePools } from '../../packages/database/store.js';
import { loadConfig } from '../../packages/config/index.js';

test('publisher issuer is an exact canonical server origin, never a caller URL/path', () => {
  for (const issuer of ['https://app.catsco.cc', 'https://example.invalid:8443', 'http://127.0.0.1:8080']) {
    assert.equal(requireCatsCoIssuer(issuer), issuer);
  }
  for (const issuer of [undefined, null, 85, '', ' ', 'https://EXAMPLE.invalid',
    'https://example.invalid/', 'https://example.invalid/api/me', 'https://example.invalid?x=1',
    'https://example.invalid#x', 'https://u:p@example.invalid', 'ftp://example.invalid',
    ' https://example.invalid', 'https://example.invalid:443', 'https://' + 'a'.repeat(2048)]) {
    assert.throws(() => requireCatsCoIssuer(issuer), { code: 'catsco.publisher_issuer_invalid' });
  }
});

test('issuer checks preserve unbound legacy identity and reject cross-issuer adoption', () => {
  const legacy = { catsco_uid: '85', catsco_issuer: null };
  assertCatsCoIssuerMatches(legacy, 'https://example.invalid');
  assert.equal(legacy.catsco_issuer, null);
  assertCatsCoIssuerMatches({ catsco_issuer: 'https://a.invalid' }, 'https://a.invalid');
  assert.throws(() => assertCatsCoIssuerMatches({ catsco_issuer: 'https://a.invalid' }, 'https://b.invalid'),
    { status: 409, code: 'catsco.publisher_issuer_conflict' });
});

const databaseUrl = process.env.SKILLHUB_TEST_DATABASE_URL;
const pg = { skip: !databaseUrl };
let store;
const ids = new Set();
before(() => { if (databaseUrl) store = createStore(loadConfig({ databaseUrl, nodeEnv: 'test' })); });
afterEach(async () => {
  if (store && ids.size) await store.query('DELETE FROM users WHERE id=ANY($1::text[])', [[...ids]]);
  ids.clear();
});
after(closePools);

function identity(overrides = {}) {
  const suffix = randomUUID();
  return { catsCoUid: `identity-${suffix}`, catsCoIssuer: 'https://issuer-a.invalid',
    namespace: `identity-${suffix}`, displayName: 'Identity fixture', contact: 'fixture',
    internalEmail: `${suffix}@example.invalid`, passwordHash: 'fixture-only', ...overrides };
}
async function claim(input) {
  const result = await store.claimCatsCoPublisherIdentity(input);
  ids.add(result.user.id);
  return result;
}
async function row(id) {
  return (await store.query('SELECT * FROM publisher_profiles WHERE user_id=$1', [id])).rows[0];
}

test('PostgreSQL issuer binding is durable and concurrent first sync creates exactly one identity', pg, async () => {
  const input = identity();
  const results = await Promise.all(Array.from({ length: 6 }, () => claim(input)));
  assert.equal(new Set(results.map(r => r.user.id)).size, 1);
  const saved = await row(results[0].user.id);
  assert.equal(saved.catsco_issuer, input.catsCoIssuer);
  assert.equal(saved.catsco_uid, input.catsCoUid);
  const otherStore = createStore(loadConfig({ databaseUrl, nodeEnv: 'test' }));
  const replay = await otherStore.claimCatsCoPublisherIdentity({ ...input, displayName: 'Renamed', namespace: `${input.namespace}-new` });
  assert.equal(replay.user.id, results[0].user.id);
  assert.equal((await row(replay.user.id)).catsco_issuer, saved.catsco_issuer);
  assert.equal(replay.developerProfile.displayName, 'Renamed');
  // Provenance remains internal, not a new public permission/capability field.
  assert.equal(replay.developerProfile.catsco_issuer, undefined);
});

test('PostgreSQL different issuers cannot race to adopt the same UID', pg, async () => {
  const input = identity();
  const results = await Promise.allSettled([claim(input), claim({ ...input,
    catsCoIssuer: 'https://issuer-b.invalid', namespace: `${input.namespace}-other`,
    internalEmail: `other-${input.internalEmail}` })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'catsco.publisher_issuer_conflict');
  const saved = await row(results.find(r => r.status === 'fulfilled').value.user.id);
  const before = { ...saved };
  const wrongIssuer = saved.catsco_issuer === input.catsCoIssuer ? 'https://issuer-b.invalid' : input.catsCoIssuer;
  await assert.rejects(claim({ ...input, catsCoIssuer: wrongIssuer, displayName: 'Must not write' }), { status: 409 });
  assert.deepEqual(await row(saved.user_id), before);
});

test('PostgreSQL legacy records stay unbound after sync and generic profile edits', pg, async () => {
  const input = identity();
  const userId = `legacy-identity-${randomUUID()}`;
  await store.query("INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'fixture','Legacy')", [userId, input.internalEmail]);
  ids.add(userId);
  await store.ensureDeveloperProfile({ userId, namespace: input.namespace, displayName: 'Legacy', contact: 'fixture', catsCoUid: input.catsCoUid });
  assert.equal((await row(userId)).catsco_issuer, null);
  const replay = await claim(input);
  assert.equal(replay.user.id, userId);
  assert.equal((await row(userId)).catsco_issuer, null, 'no automatic backfill from current configuration');
});

test('PostgreSQL bound UID issuer and owner cannot be reassigned even by generic or old SQL', pg, async () => {
  const input = identity();
  const result = await claim(input);
  const other = await claim(identity());
  const original = await row(result.user.id);
  for (const [column, value] of [['catsco_issuer', null], ['catsco_issuer', 'https://other.invalid'],
    ['catsco_uid', 'different-uid'], ['catsco_uid', null], ['user_id', other.user.id]]) {
    await assert.rejects(store.query(`UPDATE publisher_profiles SET ${column}=$2 WHERE user_id=$1`,
      [result.user.id, value]), { code: '23514' });
    assert.deepEqual(await row(result.user.id), original);
  }
  await assert.rejects(store.ensureDeveloperProfile({ userId: result.user.id, namespace: input.namespace,
    displayName: 'Changed', contact: 'fixture', catsCoUid: 'changed' }), { code: '23514' });
  await store.ensureDeveloperProfile({ userId: result.user.id, namespace: input.namespace,
    displayName: 'Normal edit', contact: 'fixture' });
  assert.equal((await row(result.user.id)).catsco_issuer, input.catsCoIssuer);
});

test('PostgreSQL failed claims roll back and do not reactivate disabled users or profiles', pg, async () => {
  const input = identity();
  const result = await claim(input);
  await assert.rejects(claim(identity({ namespace: input.namespace })), { code: 'catsco.publisher_namespace_conflict' });
  await assert.rejects(claim(identity({ catsCoIssuer: undefined })), { code: 'catsco.publisher_issuer_invalid' });
  await store.query("UPDATE users SET status='disabled' WHERE id=$1", [result.user.id]);
  await store.query("UPDATE publisher_profiles SET status='disabled' WHERE user_id=$1", [result.user.id]);
  const replay = await claim(input);
  assert.equal(replay.user.status, 'disabled');
  assert.equal(replay.developerProfile.status, 'disabled');
  assert.equal((await row(result.user.id)).catsco_issuer, input.catsCoIssuer);
});

test('PostgreSQL migration preserves preexisting publisher rows without guessing an issuer', pg, async () => {
  const migration = await readFile(new URL('../../infra/migrations/015_catsco_publisher_issuer.sql', import.meta.url), 'utf8');
  const schema = `issuer_migration_${randomUUID().replaceAll('-', '')}`;
  await store.tx(async client => {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query('CREATE TABLE publisher_profiles(id text PRIMARY KEY,user_id text,catsco_uid text,namespace text)');
    await client.query("INSERT INTO publisher_profiles VALUES('old','old-user','85','old-namespace')");
    await client.query(migration);
    assert.deepEqual((await client.query('SELECT * FROM publisher_profiles')).rows, [{
      id: 'old', user_id: 'old-user', catsco_uid: '85', namespace: 'old-namespace', catsco_issuer: null
    }]);
    await client.query("INSERT INTO publisher_profiles VALUES('new','new-user','86','new-namespace','https://a.invalid')");
    await client.query('SAVEPOINT reject_rebind');
    await assert.rejects(client.query("UPDATE publisher_profiles SET catsco_issuer=NULL WHERE id='new'"), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT reject_rebind');
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  });
});
