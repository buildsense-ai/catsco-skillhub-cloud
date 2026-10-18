import assert from 'node:assert/strict';
import https from 'node:https';
import { before, after, test } from 'node:test';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicationReceiptClient, PublicationReceiptError, RECEIPT_PATH } from '../../packages/publication-delegation/receipt-client.js';
import { publicationPeerTLS } from '../helpers/publication-peer-tls.js';

const secret='1'.repeat(64), audience='https://hub.example';
const input=()=>({schemaVersion:1,entryRequestId:'pubentry_'+'3'.repeat(32),candidateRevision:1,acceptanceEpoch:1,
  requestHash:'4'.repeat(64),sourceSnapshotHash:'5'.repeat(64),requestBytes:123,
  delegationId:'pubgrant_'+'6'.repeat(32),idempotencyKey:'pubcandidate_'+'7'.repeat(32),
  taskId:'pubtask_12345678-1234-4123-8123-123456789abc',eventId:'pubevent_12345678-1234-4123-8123-123456789abc'});
const ack=q=>({schemaVersion:1,recorded:true,entryRequestId:q.entryRequestId,eventId:q.eventId,taskId:q.taskId,
  localIntentCancelled:false,commitAllowed:false});
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
  return {config,transport,client:createPublicationReceiptClient(config,transport),calls};
}
async function fails(promise,kind='unavailable') {
  await assert.rejects(promise,e=>{
    assert.ok(e instanceof PublicationReceiptError);
    assert.equal(e.code,`skillhub.publication_receipt_${kind}`);
    assert.equal(e.cause,undefined);
    for(const value of [secret,'upstream secret','pubupload_'])assert.ok(!inspect(e).includes(value));
    return true;
  });
}
test('receipt client snapshots only historical evidence and uses pinned HTTPS service credentials',async t=>{
  const f=await fixture(t),r=input(),pending=f.client.deliver(r);r.taskId='changed';
  assert.deepEqual(await pending,ack(input()));
  await f.client.deliver(input());
  assert.equal(f.calls.length,2);
  for(const c of f.calls){
    assert.equal(c.url,RECEIPT_PATH);assert.equal(c.method,'POST');assert.deepEqual(c.q,input());
    assert.equal(c.headers.authorization,`Bearer ${secret}`);
    assert.equal(c.headers['x-skillhub-upload-grant'],undefined);
    assert.equal(c.headers['content-length'],String(Buffer.byteLength(c.body)));
    assert.ok(!c.body.includes(secret));assert.ok(!c.body.includes('source.files'));
  }
});
test('receipt defaults off and rejects malformed config or caller additions before network',async()=>{
  await fails(createPublicationReceiptClient().deliver(input()),'disabled');
  const good={enabled:true,issuer:'https://cats.example',audience,peerSecret:secret};
  for(const patch of [{issuer:'http://cats.example'},{issuer:'https://cats.example/'},{issuer:audience},
    {audience:'https://User@hub.example'},{peerSecret:secret+'\n'},{peerSecret:'A'.repeat(64)}])
    await fails(createPublicationReceiptClient({...good,...patch}).deliver(input()),'configuration');
  let calls=0;
  const client=createPublicationReceiptClient(good,{requestImpl:()=>{calls++;throw new Error('upstream secret');}});
  for(const patch of [{url:audience},{actorCatsCoUid:'1'},{token:'pubupload_x'},{schemaVersion:2},{acceptanceEpoch:0},
    {acceptanceEpoch:9},{candidateRevision:2},{requestBytes:0},{requestBytes:78643201},{requestBytes:1.5},
    {requestHash:'BAD'},{taskId:input().taskId+'\n'},{eventId:'../x'}])
    await fails(client.deliver({...input(),...patch}),'invalid');
  assert.equal(calls,0);
  await fails(client.deliver(input()));
});
test('receipt ACK requires exact matching IDs and never grants commit authority',async t=>{
  for(const patch of [{schemaVersion:2},{recorded:false},{commitAllowed:true},{localIntentCancelled:'false'},
    {entryRequestId:'wrong'},{taskId:'wrong'},{eventId:'wrong'},{extra:true}])await t.test(JSON.stringify(patch),async sub=>{
    const f=await fixture(sub,(req,res,a)=>res.end(JSON.stringify({...a,...patch})));
    await fails(f.client.deliver(input()));
  });
  const f=await fixture(t,(req,res,a)=>res.end(JSON.stringify({...a,localIntentCancelled:true})));
  assert.equal((await f.client.deliver(input())).localIntentCancelled,true);
});
test('only exact authenticated conflict envelope is permanent; malformed responses are transient',async t=>{
  for(const valid of [true,false])await t.test(String(valid),async sub=>{
    const f=await fixture(sub,(req,res)=>{res.statusCode=409;res.end(JSON.stringify({error:{
      code:valid?'publication.receipt_conflict':'other',message:'upstream secret'}}));});
    await fails(f.client.deliver(input()),valid?'conflict':'unavailable');
  });
});
test('receipt transport rejects redirects untrusted TLS encodings duplicate JSON and unbounded replies',async t=>{
  for(const mode of ['redirect','unauthorized','error','type','duplicate type','encoding','cache','size','stream','headers','utf8','duplicate','truncated','missing'])
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
          case 'duplicate':return res.end(JSON.stringify(a).replace('"recorded":true','"recorded":false,"recorded":true'));
          case 'truncated':res.setHeader('Content-Length','4000');res.write('{}');setTimeout(()=>res.destroy(),10);return;
          case 'missing':delete a.commitAllowed;break;
        }
        res.end(JSON.stringify(a));
      });
      await fails(f.client.deliver(input()));assert.equal(f.calls.length,1);
    });
  const f=await fixture(t);
  await fails(createPublicationReceiptClient(f.config).deliver(input()));assert.equal(f.calls.length,0);
});
test('receipt timeout is bounded for hanging headers and body',async t=>{
  for(const body of [false,true])await t.test(String(body),{timeout:9000},async sub=>{
    const f=await fixture(sub,(req,res)=>{if(body){res.write('{');res.flushHeaders();}});
    await fails(f.client.deliver(input()));assert.equal(f.calls.length,1);
  });
});
test('receipt concurrency and abort keep transport slots until close',async t=>{
  let release;const hold=new Promise(r=>{release=r;});
  const f=await fixture(t,(req,res,a)=>{hold.then(()=>res.end(JSON.stringify(a)));});
  const pre=new AbortController();pre.abort();await fails(f.client.deliver(input(),{signal:pre.signal}));
  assert.equal(f.calls.length,0);
  const controllers=Array.from({length:16},()=>new AbortController());
  const pending=controllers.map(c=>fails(f.client.deliver(input(),{signal:c.signal})));
  for(let i=0;i<200&&f.calls.length<16;i++)await delay(10);
  assert.equal(f.calls.length,16);await fails(f.client.deliver(input()),'busy');
  for(const c of controllers)c.abort();await Promise.all(pending);
  release();assert.deepEqual(await f.client.deliver(input()),ack(input()));
});
