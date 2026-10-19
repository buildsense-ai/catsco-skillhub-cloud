import assert from 'node:assert/strict';
import https from 'node:https';
import { before, after, test } from 'node:test';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicationCommitPermitClient, PublicationCommitPermitError, COMMIT_PERMIT_PATH } from '../../packages/publication-delegation/commit-permit-client.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const secret='1'.repeat(64), audience='https://hub.example';
const input=()=>({schemaVersion:1,receipt:{schemaVersion:1,entryRequestId:'pubentry_'+'3'.repeat(32),candidateRevision:1,acceptanceEpoch:1,
  requestHash:'4'.repeat(64),sourceSnapshotHash:'5'.repeat(64),requestBytes:123,
  delegationId:'pubgrant_'+'6'.repeat(32),idempotencyKey:'pubcandidate_'+'7'.repeat(32),
  taskId:'pubtask_12345678-1234-4123-8123-123456789abc',eventId:'pubevent_12345678-1234-4123-8123-123456789abc'},
  target:{candidateHash:'a'.repeat(64),manifestHash:'b'.repeat(64),publisherUserId:'usr_test',publisherProfileId:'pub_test',
    namespace:'publisher',skillId:'publisher/test',version:'1.0.1',uploadId:'upl_test',
    releaseAt:'2026-10-19T00:00:00.000Z',confirmVersionPublish:true}});
const ack=q=>({...q,permitId:'pubpermit_'+'c'.repeat(32),intentHash:'d'.repeat(64),authorityEpoch:1,authorizedAt:'2026-10-19T00:00:01.123456Z'});
let tls;
before(async()=>{tls=await publicationPeerTLS();});
after(async()=>{await tls?.close();});
async function fixture(t,respond=(req,res,body)=>res.end(JSON.stringify(body))) {
  const calls=[];
  const server=https.createServer(tls,async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=Buffer.concat(chunks).toString(),q=JSON.parse(body);
    calls.push({url:req.url,method:req.method,headers:req.headers,q,body});
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
    respond(req,res,ack(q));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const config={enabled:true,issuer:`https://127.0.0.1:${server.address().port}`,audience,peerSecret:secret};
  const transport={requestImpl:(url,options,callback)=>https.request(url,{...options,ca:tls.cert},callback)};
  return {config,transport,client:createPublicationCommitPermitClient(config,transport),calls};
}
async function fails(promise,kind='unavailable') {
  await assert.rejects(promise,e=>{
    assert.ok(e instanceof PublicationCommitPermitError);
    assert.equal(e.code,`skillhub.publication_commit_permit_${kind}`);
    assert.equal(e.cause,undefined);
    for(const value of [secret,'upstream secret','pubupload_'])assert.ok(!inspect(e).includes(value));
    return true;
  });
}

test('permit snapshots nested facts; preserves microseconds',async t=>{
  const f=await fixture(t),r=input(),pending=f.client.authorize(r);
  r.receipt.taskId='changed';r.target.version='2.0.0';r.target.confirmVersionPublish=false;
  const p=await pending;assert.deepEqual(p,ack(input()));
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.receipt)&&Object.isFrozen(p.target));
  assert.deepEqual(await f.client.authorize(input()),p);
  for(const c of f.calls){
    assert.equal(c.url,COMMIT_PERMIT_PATH);assert.equal(c.method,'POST');assert.deepEqual(c.q,input());
    assert.equal(c.headers.authorization,'Bearer '+secret);
    for(const h of ['x-skillhub-upload-grant','cookie','origin'])assert.equal(c.headers[h],undefined);
    assert.equal(c.headers['content-length'],String(Buffer.byteLength(c.body)));
    assert.ok(!c.body.includes(secret));
  }
});
test('permit defaults off and rejects invalid input before network',async()=>{
  await fails(createPublicationCommitPermitClient().authorize(input()),'disabled');
  const good={enabled:true,issuer:'https://cats.example',audience,peerSecret:secret};
  for(const patch of [{issuer:'http://cats.example'},{issuer:'https://cats.example/'},{issuer:audience},
    {audience:'https://User@hub.example'},{peerSecret:secret+'\n'},{peerSecret:'A'.repeat(64)}])
    await fails(createPublicationCommitPermitClient({...good,...patch}).authorize(input()),'configuration');
  let calls=0;
  const client=createPublicationCommitPermitClient(good,{requestImpl:()=>{calls++;throw new Error('upstream secret');}});
  for(const patch of [{url:audience},{actorCatsCoUid:'1'},{token:'pubupload_x'},{schemaVersion:2},{receipt:null},{target:null}])
    await fails(client.authorize({...input(),...patch}),'invalid');
  for(const patch of [{candidateHash:'BAD'},{manifestHash:'a'.repeat(64)+'\n'},{publisherUserId:'x'.repeat(129)},
    {publisherProfileId:''},{uploadId:'../x'},{namespace:'other'},{skillId:'publisher/X'},
    {version:'1x0x0'},{version:'1.0.0\n'},{releaseAt:'2026-02-31T00:00:00.000Z'},
    {releaseAt:'2026-10-19T00:00:00Z'},{confirmVersionPublish:1},{extra:true}])
    await fails(client.authorize({...input(),target:{...input().target,...patch}}),'invalid');
  for(const patch of [{extra:true},{acceptanceEpoch:9},{candidateRevision:2},{requestBytes:0}])
    await fails(client.authorize({...input(),receipt:{...input().receipt,...patch}}),'invalid');
  assert.equal(calls,0);await fails(client.authorize(input()));
});
test('permit response requires exact receipt/target and bounded evidence',async t=>{
  const changes=[
    a=>{a.schemaVersion=2;},a=>{a.extra=true;},a=>{a.permitId+='x';},a=>{a.intentHash='BAD';},
    a=>{a.authorityEpoch=0;},a=>{a.authorityEpoch=9;},a=>{a.authorityEpoch=1.5;},
    a=>{a.authorizedAt='2026-02-31T00:00:00.123456Z';},a=>{a.authorizedAt='0001-01-01T00:00:00Z';},
    a=>{a.authorizedAt='2026-10-19T00:00:00+00:00';},a=>{a.authorizedAt+='x';},
    a=>{a.receipt.taskId='other';},a=>{a.receipt.extra=true;},a=>{a.target.extra=true;},a=>{delete a.target;},
    ...Object.keys(input().target).map(k=>a=>{a.target[k]=typeof a.target[k]==='boolean'?false:'different';}),
  ];
  for(const [i,change] of changes.entries())await t.test(String(i),async sub=>{
    const f=await fixture(sub,(req,res,a)=>{change(a);res.end(JSON.stringify(a));});
    await fails(f.client.authorize(input()));
  });
  for(const at of ['2026-10-19T00:00:01Z','2026-10-19T00:00:01.123456789Z']) {
    const f=await fixture(t,(req,res,a)=>res.end(JSON.stringify({...a,authorizedAt:at,authorityEpoch:8})));
    assert.equal((await f.client.authorize(input())).authorizedAt,at);
  }
});
test('only exact authenticated status/error pairs map to stable denials',async t=>{
  for(const [status,code,kind] of [[403,'commit_denied','denied'],[409,'commit_cancelled','cancelled'],
    [409,'commit_conflict','conflict'],[403,'commit_conflict','unavailable'],[409,'commit_denied','unavailable'],
    [200,'commit_cancelled','unavailable'],[503,'commit_denied','unavailable']])
    await t.test(status+'/'+code,async sub=>{
      const f=await fixture(sub,(req,res)=>{res.statusCode=status;res.end(JSON.stringify({error:{code:'publication.'+code,message:'upstream secret'}}));});
      await fails(f.client.authorize(input()),kind);
    });
  for(const error of [{code:'publication.commit_conflict'},{code:'publication.commit_conflict',message:'x',extra:true}]) {
    const f=await fixture(t,(req,res)=>{res.statusCode=409;res.end(JSON.stringify({error}));});
    await fails(f.client.authorize(input()));
  }
});
test('permit transport rejects redirects untrusted TLS encodings duplicate JSON and unbounded replies',async t=>{
  for(const mode of ['redirect','unauthorized','error','type','duplicate type','encoding','cache','size','stream','headers','utf8','duplicate','nested duplicate','truncated','missing'])
    await t.test(mode,async sub=>{
      const f=await fixture(sub,(req,res,a)=>{
        switch(mode){
          case 'redirect':res.writeHead(307,{Location:'/elsewhere'});return res.end();
          case 'unauthorized':res.statusCode=401;return res.end('upstream secret');
          case 'error':res.statusCode=503;return res.end('upstream secret');
          case 'type':res.setHeader('Content-Type','text/html');break;
          case 'duplicate type':res.setHeader('Content-Type',['application/json','application/json']);break;
          case 'encoding':res.setHeader('Content-Encoding','gzip');break;
          case 'cache':res.setHeader('Cache-Control','public');break;
          case 'size':res.setHeader('Content-Length','9999');res.flushHeaders();return;
          case 'stream':res.write(' '.repeat(2048));return res.end(' '.repeat(2049));
          case 'headers':res.setHeader('X-Test','a'.repeat(9000));break;
          case 'utf8':return res.end(Buffer.from([255]));
          case 'duplicate':return res.end(JSON.stringify(a).replace('"schemaVersion":1','"schemaVersion":2,"schemaVersion":1'));
          case 'nested duplicate':return res.end(JSON.stringify(a).replace('"version":"1.0.1"','"version":"2.0.0","version":"1.0.1"'));
          case 'truncated':res.setHeader('Content-Length','4000');res.write('{}');setTimeout(()=>res.destroy(),10);return;
          case 'missing':delete a.intentHash;break;
        }
        res.end(JSON.stringify(a));
      });
      await fails(f.client.authorize(input()));assert.equal(f.calls.length,1);
    });
  const f=await fixture(t);
  await fails(createPublicationCommitPermitClient(f.config).authorize(input()));assert.equal(f.calls.length,0);
});
test('permit timeout is bounded for hanging headers and body',async t=>{
  for(const body of [false,true])await t.test(String(body),{timeout:9000},async sub=>{
    const f=await fixture(sub,(req,res)=>{if(body){res.write('{');res.flushHeaders();}});
    await fails(f.client.authorize(input()));assert.equal(f.calls.length,1);
  });
});
test('permit concurrency and abort keep transport slots until close',async t=>{
  let release;const hold=new Promise(r=>{release=r;});
  const f=await fixture(t,(req,res,a)=>{hold.then(()=>res.end(JSON.stringify(a)));});
  const pre=new AbortController();pre.abort();await fails(f.client.authorize(input(),{signal:pre.signal}));
  assert.equal(f.calls.length,0);
  const controllers=Array.from({length:16},()=>new AbortController());
  const pending=controllers.map(c=>fails(f.client.authorize(input(),{signal:c.signal})));
  for(let i=0;i<200&&f.calls.length<16;i++)await delay(10);
  assert.equal(f.calls.length,16);await fails(f.client.authorize(input()),'busy');
  for(const c of controllers)c.abort();await Promise.all(pending);
  release();assert.deepEqual(await f.client.authorize(input()),ack(input()));
});
