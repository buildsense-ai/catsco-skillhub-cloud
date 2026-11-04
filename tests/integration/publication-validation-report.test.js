import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePublishRequest} from '../../packages/publish-validation/index.js';
import {delegatedValidationReport} from '../../packages/publication-delegation/validation-report.js';
const source=content=>JSON.stringify({source:{type:'files',files:[{path:'SKILL.md',content}]}});
const rejected=()=>validatePublishRequest(source('---\nname: private-name\n---\nDo not disclose private source'));
test('report preserves original rule IDs, candidate digest and description confirmation without rerunning validation',()=>{
  const result=rejected(),report=result.body.error.validation;
  const projected=delegatedValidationReport(result,report.candidateHash);
  assert.deepEqual(projected,report);assert.notEqual(projected,report);
  assert.equal(projected.issues[0].code,'metadata.description_missing');
  assert.equal(projected.issues[0].repairPolicy,'confirmation_required');
  assert.ok(!JSON.stringify(projected).includes('private-name'));
  assert.ok(!JSON.stringify(projected).includes('Do not disclose'));
  const passed=validatePublishRequest(source('---\nname: valid\ndescription: Valid fixture\n---\n'));
  assert.equal(delegatedValidationReport(passed,passed.body.validation.candidateHash).outcome,'passed');
});
test('report allows only the implemented automatic name-whitespace repair policy',()=>{
  const result=validatePublishRequest(source('---\nname: " private-name "\ndescription: Valid fixture\n---\nPrivate source text'));
  assert.equal(result.status,422);
  const report=result.body.error.validation;
  const projected=delegatedValidationReport(result,report.candidateHash);
  assert.deepEqual(projected.issues.map(({code,category,blocking,location,repairPolicy})=>({code,category,blocking,location,repairPolicy})),[
    {code:'metadata.name_whitespace',category:'format',blocking:true,location:{entryIndex:0,relativePath:'SKILL.md',field:'name'},repairPolicy:'automatic'}
  ]);
  assert.ok(!JSON.stringify(projected).includes('private-name'));
  for(const mutate of [
    r=>{r.body.error.validation.issues[0].code='metadata.name_invalid';},
    r=>{r.body.error.validation.issues[0].category='compatibility';},
    r=>{r.body.error.validation.issues[0].blocking=false;},
    r=>{r.body.error.validation.issues[0].location.field='description';},
  ]) {
    const invalid=validatePublishRequest(source('---\nname: " private-name "\ndescription: Valid fixture\n---\n'));
    const hash=invalid.body.error.validation.candidateHash;mutate(invalid);
    assert.throws(()=>delegatedValidationReport(invalid,hash));
  }
});
test('report projection fails closed on corrupt, cross-candidate, over-budget and private fields',()=>{
  for(const mutate of [
    r=>r.body.error.validation.candidateHash='a'.repeat(64),
    r=>r.body.error.validation.source='private',
    r=>r.body.error.validation.issues[0].location.relativePath='private-name.txt',
    r=>r.body.error.validation.issues[0].location.field='private-field',
    r=>r.body.error.validation.issues[0].repairPolicy='automatic',
    r=>r.body.error.validation.issues[0].repairPolicy='manual',
    r=>r.body.error.validation.issues[0].message='private\ntrace',
    r=>r.body.error.validation.issues[0].message='x'.repeat(1025),
    r=>r.body.error.validation.issues=Array.from({length:51},()=>r.body.error.validation.issues[0]),
    r=>{r.body.error.validation.issues=Array.from({length:50},()=>({...r.body.error.validation.issues[0],message:'x'.repeat(1024)}));},
    r=>r.body.error.validation.coverage='partial',
    r=>r.body.error.validation.truncated='false',
    r=>r.body.error.validation.issues=[],
    r=>r.status=503,
  ]) {
    const r=rejected(),hash=r.body.error.validation.candidateHash;mutate(r);
    assert.throws(()=>delegatedValidationReport(r,hash));
  }
});
