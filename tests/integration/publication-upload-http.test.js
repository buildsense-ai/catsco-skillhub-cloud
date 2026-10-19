import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {test,before,after} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createPublicationUploadHandler,PUBLICATION_UPLOAD_PATH} from '../../apps/api/publication-upload.js';
import {PublicationAuthorityError} from '../../packages/publication-delegation/introspection.js';
import {createApiServer} from '../../apps/api/server.js';
import {loadConfig} from '../../packages/config/index.js';
import {taskError} from '../../packages/publication-tasks/store.js';
import {publicationPeerTLS} from '../helpers/publication-peer-tls.js';
const token='pubupload_'+'1'.repeat(64),entry='pubentry_'+'2'.repeat(32),source='3'.repeat(64),key='pubcandidate_'+'4'.repeat(32);
const bytes=Buffer.from('{"source":{"type":"files","files":[]}}');
const association={taskId:'pubtask_12345678-1234-4123-8123-123456789abc',entryRequestId:entry,candidateRevision:1,
  candidateHash:source,requestHash:'5'.repeat(64),authorityEpoch:1,eventId:'pubevent_12345678-1234-4123-8123-123456789abc',
  state:'delegated_pending',candidateAvailable:true};
let tls;before(async()=>{tls=await publicationPeerTLS();});after(async()=>{await tls.close();});
async function fixture(t,{plain=false,settings={},accept,check,timeoutMs=60000,config:overrides={}}={}){
  const calls=[],checks=[];
  let handler;const server=(plain?http:https).createServer(...(plain?[]:[tls]),(req,res)=>{
    void handler(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end('{}');}});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=`${plain?'http':'https'}://127.0.0.1:${server.address().port}`;
  const config=loadConfig({publicationTasksEnabled:true,publicationUploadEnabled:true,publicationUploadIssuer:'https://cats.example',
    publicationUploadAudience:origin.replace('http:','https:'),publicationUploadPeerSecret:'a'.repeat(64),...overrides});
  config.publicationUpload={...config.publicationUpload,...settings};
  handler=createPublicationUploadHandler(config,{}, {timeoutMs,
    introspectionClient:{async checkUploadGrant(input,o){checks.push(input);return check?check(input,o):{actorCatsCoUid:'7'};}},
    async accept(input,o){calls.push(input);return accept?accept(input,o):{accepted:true,created:true,association:{...association,privateSource:'SECRET'}};}});
  const send=(body=bytes,{headers={},method='POST',path=PUBLICATION_UPLOAD_PATH,idle=false}={})=>new Promise((resolve,reject)=>{
    const req=(plain?http:https).request(origin+path,{method,ca:tls.cert,servername:'localhost',agent:false,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':body.length,
        'X-Publication-Entry':entry,'X-Publication-Epoch':'1','X-Publication-Source-Hash':source,'Idempotency-Key':key,...headers}},res=>{
      let data='';res.on('data',b=>data+=b);res.on('error',reject);res.on('end',()=>{resolve({status:res.statusCode,body:JSON.parse(data),headers:res.headers});req.destroy();});
    });
    req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('test timeout')));
    if(idle)req.flushHeaders();else req.end(body);
  });
  return {send,calls,checks};
}
test('upload HTTP preserves exact bytes, minimal acceptance only, no session/service/browser fallback',async t=>{
  const f=await fixture(t);const r=await f.send();
  assert.equal(r.status,201);assert.deepEqual(r.body,{schemaVersion:1,accepted:true,created:true,association});
  assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['access-control-allow-origin'],undefined);
  assert.deepEqual(f.calls[0],{token,entryRequestId:entry,authorityEpoch:1,rawBody:bytes,sourceSnapshotHash:source,idempotencyKey:key});
  assert.equal(f.checks.length,1);assert.ok(!JSON.stringify(r.body).includes('SECRET'));
  for(const headers of [{Authorization:''},{Authorization:'Bearer '+'a'.repeat(64)},{Authorization:'Bearer session'},
    {Authorization:['Bearer '+token,'Bearer '+token]},{Cookie:'session=x'},{Origin:'https://cats.example'},{Host:'evil.invalid'}])
    assert.equal((await f.send(bytes,{headers})).status,401);
  assert.equal(f.calls.length,1);assert.equal(f.checks.length,1);
});
test('upload HTTP disabled/config/path/transport guards fail closed before introspection',async t=>{
  for(const settings of [{enabled:false},{issuer:'http://bad'},{peerSecret:'bad'},{trustedProxyAddresses:['*']}]){
    const f=await fixture(t,{settings});assert.equal((await f.send()).status,settings.enabled===false?404:503);assert.equal(f.checks.length,0);
  }
  const off=await fixture(t,{config:{publicationTasksEnabled:false}});assert.equal((await off.send()).status,503);
  const f=await fixture(t);
  for(const path of [PUBLICATION_UPLOAD_PATH+'?token=secret',PUBLICATION_UPLOAD_PATH+'/',PUBLICATION_UPLOAD_PATH+'x'])assert.equal((await f.send(bytes,{path})).status,404);
  for(const method of ['GET','OPTIONS','DELETE'])assert.equal((await f.send(bytes,{method})).status,405);
  const plain=await fixture(t,{plain:true});assert.equal((await plain.send(bytes,{headers:{'X-Forwarded-Proto':'https'}})).status,401);
  const proxy=await fixture(t,{plain:true,settings:{trustedProxyAddresses:['127.0.0.1']}});
  assert.equal((await proxy.send(bytes,{headers:{'X-Forwarded-Proto':'https'}})).status,201);
  assert.equal((await proxy.send(bytes,{headers:{'X-Forwarded-Proto':['https','https']}})).status,401);
});
test('upload HTTP strict scoped headers, length and bounded read',async t=>{
  const f=await fixture(t);
  for(const headers of [{'X-Publication-Epoch':'0'},{'X-Publication-Epoch':'01'},{'X-Publication-Epoch':'9'},
    {'X-Publication-Entry':'other'},{'X-Publication-Entry':[entry,entry]},{'X-Publication-Source-Hash':'bad'},
    {'Idempotency-Key':[key,key]},{'Content-Type':'text/plain'},{'Content-Encoding':'gzip'},{'Content-Length':'0'}])
    assert.equal((await f.send(bytes,{headers})).status,400);
  assert.equal((await f.send(bytes,{headers:{'Content-Length':String(32*1024*1024+1)}})).status,413);
  assert.equal(f.calls.length,0);assert.equal(f.checks.length,0);
  const slow=await fixture(t,{timeoutMs:30});assert.equal((await slow.send(bytes,{idle:true})).status,503);assert.equal(slow.checks.length,0);
});
test('upload HTTP checks real authority before intake and keeps all upstream errors private',async t=>{
  const denied=await fixture(t,{check:()=>{throw new PublicationAuthorityError('inactive');}});
  assert.equal((await denied.send()).status,403);assert.equal(denied.calls.length,0);
  for(const [e,status,kind] of [[Error('SECRET SQL'),503,'unavailable'],[taskError(409,'candidate_changed','SECRET'),409,'candidate_changed'],
    [taskError(409,'request_conflict','SECRET'),409,'conflict'],[taskError(403,'publisher_unverified','SECRET'),403,'publisher_unverified'],
    [taskError(429,'storage_limit','SECRET'),429,'storage_limit']]){
    const f=await fixture(t,{accept:()=>{throw e;}}),r=await f.send();assert.equal(r.status,status);
    assert.equal(r.body.error.code,'skillhub.publication_upload_'+kind);assert.ok(!JSON.stringify(r.body).includes('SECRET'));
  }
  const rejected=await fixture(t,{accept:async()=>({accepted:false,validation:{status:422,body:{private:'SECRET'}}})});
  assert.equal((await rejected.send()).status,422);
  const replay=await fixture(t,{accept:async()=>({accepted:true,created:false,association:{...association,state:'cancelled',candidateAvailable:false}})});
  const r=await replay.send();assert.equal(r.status,200);assert.equal(r.body.association.state,'cancelled');assert.equal(r.body.association.candidateAvailable,false);
});
test('upload timeout holds work slots until introspection/database settle; no early slot reuse',async t=>{
  for(const phase of ['check','accept']){
    const releases=[];
    const f=await fixture(t,{timeoutMs:35,[phase]:()=>new Promise(r=>releases.push(r))});
    const pending=Array.from({length:2},()=>f.send());
    for(const r of await Promise.all(pending))assert.equal(r.status,503);
    assert.equal(releases.length,2);assert.equal((await f.send()).body.error.code,'skillhub.publication_upload_busy');
    for(const release of releases)release(phase==='check'?{actorCatsCoUid:'7'}:{accepted:true,created:true,association});
    await delay(10);
    const next=f.send();await delay(10);assert.equal(releases.length,3);
    releases[2](phase==='check'?{actorCatsCoUid:'7'}:{accepted:true,created:true,association});
    assert.equal((await next).status,201);
    if(phase==='check')assert.equal(f.calls.length,1,'aborted pre-auth must not start intake after settling');
  }
});
test('upload account rate budget cannot be sharded with entry/token/forwarded IP',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.send(bytes,{headers:{'X-Forwarded-For':`10.0.0.${i}`}})).status,201);
  assert.equal((await f.send(bytes,{headers:{'X-Publication-Entry':'pubentry_'+'f'.repeat(32),Authorization:'Bearer pubupload_'+'f'.repeat(64)}})).status,429);
  assert.equal(f.calls.length,10);
});
test('actual API upload namespace reserved before CORS/account auth, feature defaults off',async t=>{
  const config=loadConfig({publicationUploadEnabled:false});assert.equal(config.publicationUpload.enabled,false);
  const server=createApiServer(config,{store:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const res=await fetch(base+PUBLICATION_UPLOAD_PATH,{method:'POST',headers:{Origin:'https://cats.example'},body:'{}'});
  assert.equal(res.status,404);assert.equal(res.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(base+'/healthz')).status,200);
});
