import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { preparePublication, runPreparePublication, assertPreparedPublication } from '../../packages/publication-tasks/prepare.js';
import { validatePublishRequest, readEntryFrontmatter, effectiveLimits } from '../../packages/publish-validation/index.js';
import { buildPublishedPackage, computeSkillContentHash } from '../../packages/packager/index.js';
import { normalizePackageFiles } from '../../packages/packager/files.js';
import { loadConfig } from '../../packages/config/index.js';
import { issueSigningKeyCertificate } from '../../packages/signing/index.js';

const text = '---\nname: sample\ndescription: Useful\n---\n# Private instructions\n';
const identity = { ownerId: 'owner-1', uploadId: 'upl-1', skillId: 'alice/sample', version: '1.0.3', releaseAt: '2026-10-14T00:00:00.000Z' };
const manifest = { id: identity.skillId, name: 'sample', displayName: 'Sample', description: 'Useful', version: identity.version,
  entrypoints: { skillFile: 'SKILL.md' }, runtime: { platforms: ['windows','macos','linux'] } };
const sha = value => createHash('sha256').update(value).digest('hex');
function input(files = [{ path: 'SKILL.md', content: text }], extra = {}, finalManifest = manifest, limits = {}) {
  const rawJson = JSON.stringify({ source: { type: 'files', files }, ...extra });
  const check = validatePublishRequest(rawJson, limits);
  return { rawJson, requestHash:sha(rawJson), candidateHash: (check.body.validation ?? check.body.error?.validation)?.candidateHash,
    manifest: finalManifest, identity };
}
function material(prepared) { return { manifest: prepared.manifest, files: prepared.files, identity }; }
function entry(prepared, entryPath = 'SKILL.md') {
  return readEntryFrontmatter({ buffer: Buffer.from(prepared.files.find(f => f.path === entryPath).contentBase64, 'base64') });
}

test('final preparation binds the validated candidate, exact final bytes and publication identity', async () => {
  const original = input([{ path: 'SKILL.md', content: text.replaceAll('\n','\r\n') },
    { path: 'scripts/run.js', content: 'console.log("do not execute");\r\n' },
    { path: 'skill.json', content: JSON.stringify({ name: 'sample', description: 'Useful' }) }]);
  const copy = structuredClone(original);
  const result = await runPreparePublication(original);
  assert.equal(result.status, 200);
  assert.deepEqual(original, copy);
  const p = result.prepared;
  assert.deepEqual(p.files.map(f => f.path), ['SKILL.md','scripts/run.js']);
  assert.deepEqual(p.receipt.identity, identity);
  assert.equal(p.receipt.requestHash, sha(original.rawJson));
  assert.equal(p.receipt.candidateHash, original.candidateHash);
  assert.equal(p.receipt.finalCandidateHash, result.body.validation.candidateHash);
  assert.notEqual(p.receipt.candidateHash, p.receipt.finalCandidateHash);
  assert.deepEqual(p.files, normalizePackageFiles(p.files));
  assert.equal(entry(p).data.description, 'Useful');
  assert.equal(entry(p).data.skillhub_version, '1.0.3');
  assert.equal(entry(p).body, '# Private instructions\n');
  assert.equal(Buffer.from(p.files[1].contentBase64, 'base64').toString(), 'console.log("do not execute");\r\n');
  assertPreparedPublication(p.receipt, material(p));
  assert.equal(JSON.stringify(result.body).includes('Private instructions'), false);
  const repeated = preparePublication(original).prepared;
  assert.deepEqual(p, repeated);
});

test('ZIP and files candidates prepare identical material but retain different exact request hashes', async () => {
  const bytes = Buffer.from(text), name = Buffer.from('SKILL.md'), packed = deflateRawSync(bytes);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit=0;bit<8;bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(8,8);
  local.writeUInt32LE(crc,14); local.writeUInt32LE(packed.length,18); local.writeUInt32LE(bytes.length,22); local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(8,10);
  central.writeUInt32LE(crc,16); central.writeUInt32LE(packed.length,20); central.writeUInt32LE(bytes.length,24); central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10);
  end.writeUInt32LE(central.length + name.length,12); end.writeUInt32LE(local.length + name.length + packed.length,16);
  const archive = Buffer.concat([local,name,packed,central,name,end]);
  const rawJson = JSON.stringify({ source:{ type:'zip',archiveBase64:archive.toString('base64') } });
  const original = input();
  const zipped = await runPreparePublication({ ...original,rawJson:Buffer.from(rawJson),requestHash:sha(rawJson) });
  const flat = preparePublication(original);
  assert.equal(zipped.status,200);
  assert.deepEqual(zipped.prepared.files,flat.prepared.files);
  assert.deepEqual(zipped.prepared.manifest,flat.prepared.manifest);
  assert.equal(zipped.prepared.receipt.materialHash,flat.prepared.receipt.materialHash);
  assert.equal(zipped.prepared.receipt.candidateHash,flat.prepared.receipt.candidateHash);
  assert.notEqual(zipped.prepared.receipt.requestHash,flat.prepared.receipt.requestHash);
});

for (const [name, header, expected] of [
  ['literal block', 'name: sample\ndescription: |\n  First line\n\n  Second line\n', 'First line\n\nSecond line\n'],
  ['folded block', 'name: sample\ndescription: >-\n  First line\n  Second line', 'First line Second line'],
  ['trailing blank block', 'name: sample\ndescription: |+\n  Useful\n\n', 'Useful\n\n'],
  ['quoted old service key', 'name: sample\ndescription: Useful\n"skillhub_version": "0.0.1"', 'Useful'],
  ['nested service-like key', 'name: sample\ndescription: Useful\ncustom:\n  skillhub_version: keep', 'Useful'],
  ['JSON', '{"name":"sample","description":"Useful\\nExample","skillhub_version":"0.0.1"}', 'Useful\nExample']
]) test(`metadata injection preserves ${name} semantics`, () => {
  const original = input([{ path:'SKILL.md', content:`---${name === 'JSON' ? 'json' : ''}\n${header}\n---\nBody\n` }]);
  const result = preparePublication(original);
  assert.equal(result.status,200, JSON.stringify(result.body));
  const data = entry(result.prepared).data;
  assert.equal(data.description, expected);
  assert.equal(data.name, 'sample');
  assert.equal(data.skillhub_version, identity.version);
  if (name === 'nested service-like key') assert.equal(data.custom.skillhub_version,'keep');
  assert.equal(entry(result.prepared).body, 'Body\n');
});

test('BOM, CRLF and a custom entrypoint keep the selected runtime instructions', () => {
  const customManifest = { ...manifest, entrypoints: { skillFile: 'nested/SKILL.md' } };
  const original = input([{ path:'nested/SKILL.md', content:'\uFEFF' + text.replaceAll('\n','\r\n') }],
    { manifest: { entrypoints: { skillFile:'nested/SKILL.md' } } }, customManifest);
  const result = preparePublication(original);
  assert.equal(result.status,200);
  assert.equal(entry(result.prepared,'nested/SKILL.md').data.description,'Useful');
  assert.equal(entry(result.prepared,'nested/SKILL.md').body,'# Private instructions\r\n');
  assert.equal(preparePublication({ ...original, manifest }).body.error.code, 'skillhub.publication_prepare_entrypoint_changed');
});

test('an old candidate hash cannot authorize changed descriptions, manifests or files', () => {
  const original = input();
  for (const altered of [
    { ...original, rawJson: original.rawJson.replace('Useful','Different') },
    { ...original, rawJson: original.rawJson.replace('Private instructions','Other body') },
    { ...input(undefined, { manifest:{ description:'catalogue change' } }), candidateHash: original.candidateHash }
  ]) assert.equal(preparePublication(altered).status,409);
  assert.equal(preparePublication({ ...original, candidateHash:'a'.repeat(64) }).body.error.code,'skillhub.publication_prepare_candidate_changed');
  assert.equal(preparePublication({ ...original, rawJson:original.rawJson + ' ' }).body.error.code,'skillhub.publication_prepare_request_changed');
});

test('bad original metadata is rejected before it could be replaced by derived metadata', () => {
  const base = input();
  for (const rawJson of [
    input([{path:'SKILL.md',content:text.replace('description: Useful\n','')}]).rawJson,
    input([{path:'SKILL.md',content:text},{path:'skill.json',content:'{"name":"first","name":"second"}'}]).rawJson
  ]) {
    const result = preparePublication({ ...base, rawJson, requestHash:sha(rawJson) });
    assert.equal(result.status,422);
    assert.equal(result.prepared,undefined);
    assert.ok(result.body.error.validation.issues.length);
  }
});

test('unsafe paths and files silently dropped by legacy packaging cannot pass strict preparation', () => {
  const unsafe = input([{path:'SKILL.md',content:text},{path:'../secret',content:'secret'}]);
  assert.notEqual(preparePublication({ ...unsafe, candidateHash:'a'.repeat(64) }).status,200);
  const nested = input([{path:'SKILL.md',content:text},{path:'scripts/skill.json',content:'{"runtime":"needed"}'}]);
  assert.equal(validatePublishRequest(nested.rawJson).status,200);
  const result = preparePublication(nested);
  assert.equal(result.body.error.code,'skillhub.publication_prepare_file_would_be_removed');
  assert.equal(result.prepared,undefined);
});

test('final expanded material is validated with the same limits, including metadata growth', () => {
  const original = input();
  assert.equal(validatePublishRequest(original.rawJson,{ maxSingleFileBytes:100 }).status,200);
  const result = preparePublication(original,{ maxSingleFileBytes:100 });
  assert.equal(result.status,413);
  assert.equal(result.prepared,undefined);
  const finalInvalid = preparePublication({ ...original, manifest:{ ...manifest, runtime:{ platforms:[] } } });
  assert.equal(finalInvalid.status,422);
  assert.equal(finalInvalid.prepared,undefined);
});

test('receipts reject material, metadata, identity, rules and limits changes before signing', () => {
  const p = preparePublication(input()).prepared;
  for (const key of Object.keys(identity)) {
    const changed = { ...identity, [key]:key === 'releaseAt' ? '2026-10-15T00:00:00.000Z' : 'different' };
    assert.throws(() => assertPreparedPublication(p.receipt,{ ...material(p),identity:changed }),{ status:409 });
  }
  for (const changed of [
    { ...material(p),manifest:{ ...p.manifest,description:'changed' } },
    { ...material(p),files:p.files.map(f=>({ ...f,contentBase64:Buffer.from('tampered').toString('base64') })) },
    { ...material(p),files:[] }
  ]) assert.throws(() => assertPreparedPublication(p.receipt,changed),{ status:409 });
  for (const receipt of [null,{}, { ...p.receipt,ruleVersion:'old' }, { ...p.receipt,candidateHash:null }]) {
    assert.throws(() => assertPreparedPublication(receipt,material(p)),{ code:'skillhub.publication_prepare_mismatch' });
  }
  assert.throws(() => assertPreparedPublication(p.receipt,material(p),{ maxFiles:499 }),{ status:409 });
  const normalizedManifestMutation = { ...p.manifest, description:'modified' };
  // The old dedup hash excludes the manifest, so it is not a publication receipt.
  assert.equal(computeSkillContentHash(p.files),computeSkillContentHash([...p.files,
    {path:'skill.json',content:JSON.stringify(normalizedManifestMutation)}]));
});

test('invalid publication context and invalid UTF-8 never produce prepared material', async () => {
  const original = input();
  for (const bad of [{ ...original,identity:{ ...identity,version:'9.0.0' } },
    { ...original,identity:{ ...identity,releaseAt:'today' } }, { ...original,candidateHash:null },
    { ...original,rawJson:Buffer.from([0xff]) }]) {
    const result = await runPreparePublication(bad);
    assert.equal(result.status,400);
    assert.equal(result.prepared,undefined);
  }
});

test('preparation worker obeys cancellation and timeout without returning private partial output', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runPreparePublication(input(),undefined,{ signal:controller.signal }),{ status:503 });
  await assert.rejects(runPreparePublication(input(),undefined,{ timeoutMs:1 }),{ status:503 });
  const failed = await runPreparePublication(null);
  assert.equal(failed.status,400);
  assert.equal(failed.prepared,undefined);
});

test('packager consumes exactly validated bytes and rejects mismatches before filesystem side effects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'skillhub-prepared-'));
  try {
    const config = loadConfig({ root,nodeEnv:'test',allowAutoKeygen:true });
    const limits = effectiveLimits({ ...config.limits,...config.publishValidation.limits });
    const p = preparePublication(input(),limits).prepared;
    const args = { config,submission:{ id:identity.uploadId,submitterId:identity.ownerId,normalizedManifest:p.manifest },
      files:p.files,scanRun:{ id:'scan-1',riskLevel:'low' }, reviewer:{ id:identity.ownerId },
      sourceVersion:{ repositoryId:'repo-1',commitSha:'a'.repeat(40),treeSha:'b'.repeat(40),tag:`v${identity.version}` },
      releaseAt:identity.releaseAt,preparedPublication:p.receipt };
    await assert.rejects(buildPublishedPackage({ ...args,releaseAt:'2026-10-15T00:00:00.000Z' }),{ status:409 });
    await assert.rejects(buildPublishedPackage({ ...args,preparedPublication:null }),{ status:409 });
    assert.deepEqual(await fs.readdir(root),[]);
    await issueSigningKeyCertificate(config);
    const built = await buildPublishedPackage(args);
    const artifact = JSON.parse(await fs.readFile(built.packagePath,'utf8'));
    assert.deepEqual(artifact.payload.files,p.files);
    assert.deepEqual(artifact.payload.manifest,p.manifest);
    assert.equal(built.publishedAt,identity.releaseAt);
  } finally { await fs.rm(root,{ recursive:true,force:true }); }
});
