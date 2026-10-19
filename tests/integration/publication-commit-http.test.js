import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {test,before,after} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createPublicationCommitHandler,PUBLICATION_COMMIT_PATH} from '../../apps/api/publication-commit.js';
import {DelegatedCommitError} from '../../packages/publication-delegation/commit-coordinator.js';
import {PublicationCommitPermitError} from '../../packages/publication-delegation/commit-permit-client.js';
import {createApiServer} from '../../apps/api/server.js';
import {loadConfig} from '../../packages/config/index.js';
import {publicationPeerTLS} from '../helpers/publication-peer-tls.js';
const secret='1'.repeat(64);
const receipt={schemaVersion:1,entryRequestId:'pubentry_'+'2'.repeat(32),candidateRevision:1,acceptanceEpoch:1,
  requestHash:'3'.repeat(64),sourceSnapshotHash:'4'.repeat(64),requestBytes:123,delegationId:'pubgrant_'+'5'.repeat(32),
  idempotencyKey:'pubcandidate_'+'6'.repeat(32),taskId:'pubtask_12345678-1234-4123-8123-123456789abc',eventId:'pubevent_12345678-1234-4123-8123-123456789abc'};
const input=(action='plan')=>({schemaVersion:1,action,receipt,...(action==='plan'?{confirmVersionPublish:false}:{})});
let tls;before(async()=>{tls=await publicationPeerTLS();});after(async()=>{await tls.close();});
async function fixture(t,{plain=false,settings={},coordinator,timeoutMs=20000}={}){
  const calls=[];coordinator??={prepare:async(r,o)=>{calls.push(['plan',r,o]);return {schemaVersion:1,receipt:r,target:{}};},
    read:async r=>{calls.push(['read',r]);return {schemaVersion:1,receipt:r,state:'delegated_pending'};},
    authorize:async r=>{calls.push(['authorize',r]);return {state:'committing',permitId:'pubpermit_'+'a'.repeat(32),replayed:true};}};
  let handler;const server=(plain?http:https).createServer(...(plain?[]:[tls]),(req,res)=>{
    void handler(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end('{}');}});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=`${plain?'http':'https'}://127.0.0.1:${server.address().port}`;
  handler=createPublicationCommitHandler({publicationCommitService:{enabled:true,issuer:'https://cats.example',
    audience:origin.replace('http:','https:'),peerSecret:secret,trustedProxyAddresses:[],...settings}}, {}, {coordinator,timeoutMs});
  const send=(body=input(),{headers={},method='POST',path=PUBLICATION_COMMIT_PATH,idle=false}={})=>new Promise((resolve,reject)=>{
    const req=(plain?http:https).request(origin+path,{method,ca:tls.cert,servername:'localhost',agent:false,
      headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',...headers}},res=>{
      let data='';res.on('data',b=>data+=b);res.on('error',reject);res.on('end',()=>{resolve({status:res.statusCode,body:JSON.parse(data),headers:res.headers});req.destroy();});
    });
    req.on('error',reject);req.setTimeout(2000,()=>req.destroy(Error('test timeout')));
    if(idle)req.flushHeaders();else req.end(typeof body==='string'?body:JSON.stringify(body));
  });
  return {send,calls};
}
test('commit HTTP strict peer auth, plan/read/authorize action and no browser/session fallback',async t=>{
  const f=await fixture(t);
  for(const action of ['plan','read','authorize']){
    const r=await f.send(input(action));assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');
    assert.deepEqual(r.body.receipt,receipt);assert.equal(r.headers['access-control-allow-origin'],undefined);
  }
  assert.equal(f.calls.length,3);assert.equal(f.calls[0][2].confirmVersionPublish,false);
  for(const headers of [{Authorization:''},{Authorization:'Bearer pubupload_'+secret},
    {Authorization:['Bearer '+secret,'Bearer '+secret]},{Cookie:'session=x'},{Origin:'https://cats.example'},{Host:'other.invalid'}])
    assert.equal((await f.send(input(),{headers})).status,401);
  assert.equal(f.calls.length,3);
});
test('commit HTTP default-off/configuration/path guards and pinned proxy TLS',async t=>{
  for(const settings of [{enabled:false},{issuer:'http://bad'},{peerSecret:'bad'},{trustedProxyAddresses:['*']}]){
    const f=await fixture(t,{settings});assert.equal((await f.send()).status,settings.enabled===false?404:503);assert.equal(f.calls.length,0);
  }
  const f=await fixture(t);
  for(const path of [PUBLICATION_COMMIT_PATH+'?x=1',PUBLICATION_COMMIT_PATH+'/',PUBLICATION_COMMIT_PATH+'ment'])assert.equal((await f.send(input(),{path})).status,404);
  for(const method of ['GET','OPTIONS','DELETE'])assert.equal((await f.send(input(),{method})).status,405);
  const plain=await fixture(t,{plain:true});assert.equal((await plain.send(input(),{headers:{'X-Forwarded-Proto':'https'}})).status,401);
  const proxy=await fixture(t,{plain:true,settings:{trustedProxyAddresses:['127.0.0.1']}});
  assert.equal((await proxy.send(input(),{headers:{'X-Forwarded-Proto':'https'}})).status,200);
  assert.equal((await proxy.send(input(),{headers:{'X-Forwarded-Proto':['https','https']}})).status,401);
});
test('commit HTTP rejects caller targets, approval identity, credentials, duplicate JSON and unbounded inputs',async t=>{
  const f=await fixture(t);
  for(const body of [null,[],{},input('cancel'),{...input(),target:{}},{...input(),actorUid:'85'},
    {...input(),confirmVersionPublish:'true'},{...input('authorize'),confirmVersionPublish:true},
    {...input(),receipt:{...receipt,token:'private'}},JSON.stringify(input()).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'),
    'x'.repeat(4097)])assert.equal((await f.send(body)).status,400);
  for(const headers of [{'Content-Type':'text/plain'},{'Content-Encoding':'gzip'},{'Content-Length':'4097'}])assert.equal((await f.send(input(),{headers})).status,400);
  assert.equal(f.calls.length,0);
});
test('commit HTTP maps only typed errors, retaining no raw peer/SQL data',async t=>{
  for(const [e,status,kind] of [[new DelegatedCommitError('cancelled'),409,'cancelled'],[new DelegatedCommitError('not_found'),404,'not_found'],
    [new DelegatedCommitError('confirmation_required'),409,'confirmation_required'],[new DelegatedCommitError('rejected'),422,'rejected'],
    [new DelegatedCommitError('storage_limit'),429,'storage_limit'],[new PublicationCommitPermitError('denied'),403,'publisher_changed'],
    [new PublicationCommitPermitError('conflict'),409,'conflict'],[Error('private SQL password'),503,'unavailable']]){
    const f=await fixture(t,{coordinator:{prepare(){throw e;}}});const r=await f.send();assert.equal(r.status,status);
    assert.equal(r.body.error.code,'skillhub.delegated_commit_'+kind);assert.ok(!JSON.stringify(r.body).includes('password'));
  }
});
test('commit HTTP timeout/abort retain four work slots until actual settlement',async t=>{
  const releases=[];const f=await fixture(t,{timeoutMs:30,coordinator:{prepare:()=>new Promise(r=>releases.push(r))}});
  const pending=Array.from({length:4},()=>f.send());
  for(const r of await Promise.all(pending))assert.equal(r.status,503);
  assert.equal(releases.length,4);assert.equal((await f.send()).body.error.code,'skillhub.delegated_commit_busy');
  for(const release of releases)release({});await delay(10);
  const again=f.send();await delay(10);assert.equal(releases.length,5);releases[4]({});assert.equal((await again).status,200);
  const slow=await fixture(t,{timeoutMs:25});assert.equal((await slow.send(input(),{idle:true})).status,503);assert.equal(slow.calls.length,0);
});
test('actual API reserves disabled commit route before account auth/CORS without changing health',async t=>{
  const config=loadConfig({publicationCommitServiceEnabled:false});
  const server=createApiServer(config,{store:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const res=await fetch(base+PUBLICATION_COMMIT_PATH,{method:'POST',headers:{Origin:'https://cats.example'},body:'{}'});
  assert.equal(res.status,404);assert.equal(res.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(base+'/healthz')).status,200);
});
