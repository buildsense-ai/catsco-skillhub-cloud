import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "yaml";
import { describeRules, parseStrictJson, validatePublishRequest } from "../../packages/publish-validation/index.js";
import { runPublishValidation } from "../../packages/publish-validation/runner.js";

const skillBody = frontmatter => ({ source: { type: "files", files: [
  { path: "SKILL.md", content: `---\nname: sample\ndescription: useful\n${frontmatter}\n---\n# Example\n` }
] } });
const run = (frontmatter, limits) => validatePublishRequest(JSON.stringify(skillBody(frontmatter)), limits);

test("JSON streaming gate charges the exact old node units before materialization", () => {
  assert.deepEqual(parseStrictJson('{"a":[1,2]}', { maxNodes: 6 }), { a: [1, 2] });
  assert.throws(() => parseStrictJson('{"a":[1,2]}', { maxNodes: 5 }), { status: 413, code: "json.limit_exceeded" });
  assert.throws(() => parseStrictJson('{"a":1,"\\u0061":2}'), { status: 400, code: "json.duplicate_key" });
  assert.deepEqual(parseStrictJson('{"a":[{"b":1},{"b":2}]}'), { a: [{ b: 1 }, { b: 2 }] });
  // The invalid tail must never be visited after the node budget has run out.
  assert.throws(() => parseStrictJson('[0,0,0,0,0,invalid]', { maxNodes: 4 }), { status: 413 });
});

test("YAML has an explicit lexical budget with exact boundary, independent of AST nodes", () => {
  const text = 'name: sample\ndescription: useful\nx: [1, 2]';
  let tokens = 0;
  for (const _token of new Lexer().lex(text)) tokens++;
  assert.equal(describeRules().limits.maxYamlTokens, 100_000);
  assert.equal(run('x: [1, 2]', { maxYamlTokens: tokens }).status, 200);
  const rejected = run('x: [1, 2]', { maxYamlTokens: tokens - 1 });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.error.code, "frontmatter.limit_exceeded");
});

test("YAML lexical gate covers wide nulls, empty collections, comments and aliases", () => {
  for (const value of [
    'x: [' + ','.repeat(60) + ']',
    'x:\n' + '  -\n'.repeat(60),
    'x: [' + '{},'.repeat(60) + '{}]',
    'x: { ' + Array.from({length:60}, (_,i) => `a${i}:`).join(', ') + ' }',
    'a: &base 1\nx: [' + '*base,'.repeat(60) + '*base]',
    '# comment\n'.repeat(60) + 'x: 1'
  ]) {
    const result = run(value, { maxYamlTokens: 40 });
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, "frontmatter.limit_exceeded");
  }
});

test("bounded parser stack rejects deep YAML block and flow forms before AST composition", () => {
  for (const value of [
    'x: ' + '['.repeat(1000) + '0' + ']'.repeat(1000),
    'x:\n  ' + '- '.repeat(1000) + '0',
    Array.from({length:1000}, (_,i) => ' '.repeat(i) + `a${i}:`).join('\n'),
    Array.from({length:100}, (_,i) => ' '.repeat(i * 2) + '- a:').join('\n'),
    'x:\n' + Array.from({length:100}, (_,i) => ' '.repeat(i * 2) + '?').join('\n')
  ]) {
    const result = run(value);
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, "frontmatter.limit_exceeded");
  }
});

test("large punctuation in quoted, block and plain scalars is not counted as YAML structure", () => {
  const punctuation = '[,]:{}?# - '.repeat(10_000);
  for (const value of [
    `x: "${punctuation}"`,
    `x: '${punctuation}'`,
    `x: |\n  ${punctuation}\n`,
    'x: ' + 'ordinary-text-'.repeat(10_000)
  ]) assert.equal(run(value).status, 200);
  assert.equal(run('x: |\n  - a: [b, c]\n  ? not-a-collection\n').status, 200);
});

test("reviewer-scale wide inputs return clean 413 in a 128 MiB worker", { timeout: 60_000 }, async () => {
  // Stay below existing transport/file ceilings. The old AST-first parser
  // exhausted its heap here; no full tree should be allocated by these probes.
  for (const length of [600_000, 1_200_000]) {
    const raw = JSON.stringify(skillBody('x: [' + '1,'.repeat(length) + '1]'));
    const result = await runPublishValidation(Buffer.from(raw), {}, { memoryMb: 128, timeoutMs: 15000 });
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, "frontmatter.limit_exceeded");
  }
  const prefix = JSON.stringify(skillBody('x: 1')).slice(0, -1);
  const raw = prefix + ',"manifest":{"wide":[' + '1,'.repeat(12_000_000) + '1]}}';
  assert.ok(Buffer.byteLength(raw) < describeRules().limits.maxRequestBytes);
  const result = await runPublishValidation(Buffer.from(raw), {}, { memoryMb: 128, timeoutMs: 15000 });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, "json.limit_exceeded");
  // A failed hostile candidate must not poison the next worker invocation.
  assert.equal((await runPublishValidation(JSON.stringify(skillBody('x: 1')), {}, { memoryMb:128 })).status, 200);
});
