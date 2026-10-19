import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validatePublishRequest} from '../../packages/publish-validation/index.js';

// Reviewed XiaoBa real filesystem/capture implementation, not synthetic bytes.
// The fixture binds a test-only local Bot. Live CatsCo capture dispatch/grant
// issuance is NOT simulated as implemented by this digest/upload contract.
export async function runtimePublicationCaptures(){
  assert.ok(process.env.XIAOBA_CONTRACT_ROOT&&process.env.XIAOBA_CONTRACT_REVISION,'pinned XiaoBa checkout REQUIRED; no skip');
  const runtime=path.resolve(process.env.XIAOBA_CONTRACT_ROOT);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:runtime,encoding:'utf8'}).trim(),process.env.XIAOBA_CONTRACT_REVISION);
  const require=createRequire(path.join(runtime,'package.json'));
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-runtime-capture-'));
  try{
    const raw=execFileSync(process.execPath,[require.resolve('tsx/cli'),path.join(runtime,'tests/fixtures/publication-capture-contract.ts'),temp],
      {cwd:runtime,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
    const rows=JSON.parse(raw);assert.deepEqual(rows.map(r=>r.kind),['valid','invalid','script']);
    for(const row of rows){
      const result=validatePublishRequest(row.request),validation=result.body.validation??result.body.error?.validation;
      assert.equal(validation.candidateHash,row.receipt.sourceSnapshotHash);
      assert.equal(createHash('sha256').update(row.request).digest('hex'),row.receipt.requestHash);
      assert.equal(Buffer.byteLength(row.request),row.receipt.requestBytes);
      assert.equal(validation.outcome,row.kind==='valid'?'passed':'rejected');
    }
    return rows;
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
