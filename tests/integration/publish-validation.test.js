import assert from "node:assert/strict";
import test from "node:test";
import { describeRules, parseStrictJson, validatePublishRequest } from "../../packages/publish-validation/index.js";

const skill = (head = "name: 文档读取\ndescription: 读取用户提供的文档") => `---\n${head}\n---\n# Example\n`;
const body = (text = skill(), extras = [], manifest) => ({source:{type:"files",files:[{path:"SKILL.md",content:text},...extras]}, ...(manifest === undefined ? {} : {manifest})});
const run = (input = body(), limits) => validatePublishRequest(JSON.stringify(input), limits);
const report = r => r.body.validation ?? r.body.error?.validation;
const codes = r => report(r)?.issues.map(i => i.code) ?? [];

test("rules describe preflight only, bounded output and effective limits", () => {
  const rules = describeRules({maxFiles:12,maxIssues:100,maxReportBytes:100000});
  assert.equal(rules.limits.maxFiles,12);
  assert.equal(rules.limits.maxIssues,50);
  assert.equal(rules.limits.maxReportBytes,49152);
  assert.equal(rules.capabilities.publicationTasks,false);
  assert.equal(rules.capabilities.automaticRepair,false);
  assert.throws(() => describeRules({maxFiles:0}));
});

test("valid Chinese metadata, multiline descriptions, extensions, no image requirement", () => {
  for (const text of [skill(),skill('name: skill\ndescription: |\n  First line: value\n  第二行\ncustom: true'), skill(`name: skill\ndescription: "${'长'.repeat(2000)}"`), '\uFEFF'+skill().replaceAll('\n','\r\n')]) {
    assert.equal(run(body(text)).status,200);
  }
});

test("absence of frontmatter or fields cannot be masked by outside metadata", () => {
  const outside = {name:'outside',description:'outside'};
  assert.ok(codes(run(body('# Plain README',[],outside))).includes('frontmatter.missing'));
  const r = run(body(skill('name: sample'),[],outside));
  assert.equal(r.status,422);
  const problem = report(r).issues.find(i => i.code==='metadata.description_missing');
  assert.equal(problem.repairPolicy,'confirmation_required');
  assert.equal(report(r).nextAction,'review_report');
});

test("metadata types and whitespace are not repaired", () => {
  for (const [head,code] of [
    ['name: " x "\ndescription: fine','metadata.name_whitespace'],
    ['name: 13\ndescription: fine','metadata.name_invalid'],
    ['name: x\ndescription: [one,two]','metadata.description_type'],
    ['name: x\ndescription: "  "','metadata.description_missing']
  ]) assert.ok(codes(run(body(skill(head)))).includes(code));
});

test("JSON and YAML duplicates are rejected, including escaped JSON names", () => {
  for (const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"a":{"b":1,"b":2}}']) assert.throws(() => parseStrictJson(text), /重复/);
  assert.ok(codes(run(body(skill('name: a\nname: b\ndescription: okay')))).includes('frontmatter.duplicate_key'));
  assert.equal(validatePublishRequest('{"source":{},"source":{}}').status,400);
  assert.equal(run(body(skill(),[{path:'skill.json',content:'{"name":"a","name":"b"}'}])).status,422);
});

test("strict request schema rejects coercion, ambiguous sources and nonfinite parameters", () => {
  for (const value of [null,[],{...body(),form:{},manifest:{}},body(skill(),[],null),{...body(),extra:1}]) {
    assert.equal(run(value).status,400);
  }
  assert.equal(validatePublishRequest('{"source":{"type":"files","files":[]},"manifest":{"x":1e400}}').status,400);
  const invalid = body(); invalid.source.files[0].content={a:1};
  assert.equal(run(invalid).status,400);
});

test("safe JSON frontmatter allowed, executable engines and YAML tags rejected", () => {
  assert.equal(run(body('---json\n{"name":"x","description":"y"}\n---\n')).status,200);
  assert.equal(run(body('--- json\n{"name":"x","description":"y"}\n---\n')).status,200);
  for (const value of ['---javascript\n({name:"x",description:"y"})\n---\n',skill('name: x\ndescription: !!js/function "function(){}"'),skill('name: x\ndescription: !custom y')]) assert.equal(run(body(value)).status,422);
});

test("unpaired Unicode in file transport is rejected rather than silently replaced", () => {
  assert.equal(run(body(skill(),[{path:'x',content:'\ud800'}])).status,400);
  assert.equal(run(body(skill(),[{path:'\ud800',content:''}])).status,400);
});

test("original malformed skill.json is not hidden by explicit valid manifest", () => {
  assert.ok(codes(run(body(skill(),[{path:'skill.json',content:'bad json'}],{name:'x',description:'y'}))).includes('manifest.invalid_json'));
  assert.ok(codes(run(body(skill(),[{path:'skill.json',content:'{"version":"wrong"}'}],{version:'1.0.0'}))).includes('manifest.version_invalid'));
  for (const original of [{platforms:['NOT_A_PLATFORM']},{entrypoints:{skillFile:'../escape'}},{runtime:null},{platforms:null}]) {
    assert.equal(run(body(skill(),[{path:'skill.json',content:JSON.stringify(original)}],{platforms:['linux'],entrypoints:{skillFile:'SKILL.md'},runtime:{}})).status,422);
  }
  assert.equal(run(body(skill(),[],{platforms:null})).status,422);
});

test("explicit entrypoint wins without rejecting nested sample SKILL.md files", () => {
  const input = {source:{type:'files',files:[{path:'docs/main.md',content:skill()},{path:'sample/SKILL.md',content:'sample'}]},manifest:{entrypoints:{skillFile:'docs/main.md'}}};
  assert.equal(run(input).status,200);
  assert.ok(codes(run(input)).includes('compatibility.custom_entrypoint'));
  assert.equal(run(body(skill(),[{path:'sample/SKILL.md',content:'sample'}])).status,200);
  assert.ok(codes(run(body(skill(),[],{entrypoints:{skillFile:'SKILL.md'},skillFile:'another.md'}))).includes('entrypoint.ambiguous'));
});

test("missing entrypoint never selects an arbitrary wrapper or nested root", () => {
  const input = {source:{type:'files',files:[{path:'a/SKILL.md',content:skill()},{path:'b/SKILL.md',content:skill()}]}};
  assert.ok(codes(run(input)).includes('entrypoint.ambiguous'));
});

test("path traversal, duplicate and prefix conflicts reject before hashing", () => {
  for (const files of [
    [{path:'../outside',content:'secret'}], [{path:'/absolute',content:'x'}],
    [{path:'SKILL.md',content:skill()}], [{path:'a',content:''},{path:'a/b',content:''}],
    [{path:'skill.json',content:'{}'},{path:'skill.json',content:'{}'}]
  ]) {
    const result = run(body(skill(),files));
    assert.equal(result.status,422); assert.equal(report(result).candidateHash,null);
    assert.equal(report(result).coverage,'partial');
  }
});

test("platform checks distinguish Linux-only from default insensitive targets", () => {
  const files = [{path:'script.py',content:''},{path:'Script.py',content:''}];
  assert.equal(run(body(skill(),files)).status,422);
  assert.equal(run(body(skill(),files,{platforms:['linux']})).status,200);
  assert.equal(run(body(skill(),[{path:'CON.txt',content:''}])).status,422);
  assert.equal(run(body(skill(),[],{platforms:[]})).status,422);
  assert.equal(run(body(skill(),[],{runtime:{platforms:['unknown']}})).status,422);
});

test("exact candidate digest covers bytes and submitted parameters, independent of order", () => {
  const original=body(skill(),[{path:'skill.json',content:'{"license":"MIT"}'}]);
  const hash=report(run(original)).candidateHash;
  const reversed=structuredClone(original); reversed.source.files.reverse();
  assert.equal(report(run(reversed)).candidateHash,hash);
  for (const change of [body(skill().replaceAll('\n','\r\n'),original.source.files.slice(1)),body(skill(),[{path:'skill.json',content:'{"license":"other"}'}]),{...original,manifest:{license:'other'}}]) assert.notEqual(report(run(change)).candidateHash,hash);
  const a={...original,manifest:{name:'x',description:'y'}};
  const b={...original,form:{description:'y',name:'x'}};
  assert.equal(report(run(a)).candidateHash,report(run(b)).candidateHash);
});

test("normal network/shell/env examples do not become blocking keyword findings", () => {
  const result=run(body(skill()+'\ncurl https://example.com\nAPI_KEY=$API_KEY\nbash -c example\n', [{path:'script.sh',content:'#!/bin/sh\ncurl https://example.com'}]));
  assert.equal(result.status,200);
});

test("report is bounded by serialized wire size and does not disclose arbitrary filenames", () => {
  const files=Array.from({length:70},(_,i)=>({path:`secret-token-${i}/..`,content:''}));
  const result=run(body(skill(),files),{maxReportBytes:2048});
  assert.equal(result.status,422);
  assert.equal(report(result).truncated,true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body,null,2)+'\n')<=2048);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test("processing budgets fail safely, no passed partial report", () => {
  assert.equal(run(body(),{maxFiles:1}).status,200);
  assert.equal(run(body(skill(),[{path:'extra',content:''}]),{maxFiles:1}).status,413);
  assert.equal(run(body(),{maxSingleFileBytes:1}).status,413);
  assert.equal(run(body(skill(),[{path:'skill.json',content:'{"a":{"b":{"c":1}}}'}]),{maxDepth:5}).status,200);
  const hugeHead='name: x\ndescription: y\nextra: '+ '['.repeat(70)+'1'+']'.repeat(70);
  const result=run(body(skill(hugeHead)));
  assert.equal(result.status,413);
  assert.equal(result.body.validation,undefined);
  assert.throws(() => parseStrictJson('['+'0,'.repeat(129999)+'0]'), e=>e.code==='json.limit_exceeded' && e.status===413);
  assert.equal(run(body(skill(),[{path:'skill.json',content:'['+'0,'.repeat(1000)+'0]'}]),{maxNodes:500}).status,413);
});

test("preflight leaves caller-owned request unchanged and has no task id", () => {
  const input=body(); const before=JSON.stringify(input);
  const result=run(input);
  assert.equal(JSON.stringify(input),before);
  assert.equal(report(result).publicationTaskId,undefined);
  assert.equal(result.body.upload,undefined);
});
