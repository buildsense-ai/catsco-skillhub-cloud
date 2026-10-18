import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicationReceiptDispatcher } from '../../packages/publication-delegation/receipt-worker.js';
import { PublicationReceiptError } from '../../packages/publication-delegation/receipt-client.js';

const config={enabled:true,issuer:'https://cats.example',audience:'https://hub.example',peerSecret:'1'.repeat(64),store:{tx(){throw new Error('not injected');}}};
const receipt={entryRequestId:'entry',eventId:'event',taskId:'task'};
const ack={schemaVersion:1,recorded:true,...receipt,localIntentCancelled:true,commitAllowed:false};
async function until(check){for(let i=0;i<200&&!check();i++)await delay(5);assert.ok(check());}
test('receipt dispatcher is default-off without touching storage or network',async()=>{
  const d=createPublicationReceiptDispatcher({},new Proxy({},{get(){throw new Error('must not read dependency');}}));
  assert.equal(await d.runOnce(),null);d.start();assert.equal(d.status().started,false);await d.stop();
  assert.throws(()=>createPublicationReceiptDispatcher({enabled:true}),{code:'skillhub.publication_receipt_configuration'});
});
test('dispatcher startup automatically sweeps serially and stop aborts and awaits inflight work',async()=>{
  let claims=0,finishes=0,delivering=0,maximum=0;
  const d=createPublicationReceiptDispatcher(config,{pollIntervalMs:10,
    ledger:{async claim(){claims++;return {receipt,token:'lease'};},async finish(lease,outcome){finishes++;assert.equal(outcome.kind,'retry');return true;}},
    client:{async deliver(r,{signal}){delivering++;maximum=Math.max(maximum,delivering);
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));delivering--;throw new Error('private raw error');}}});
  d.start();d.start();await until(()=>delivering===1);await delay(40);assert.equal(claims,1);
  await d.stop();assert.equal(finishes,1);assert.equal(maximum,1);assert.equal(d.status().inflight,0);
  assert.equal(await d.runOnce(),null);await delay(30);assert.equal(claims,1);
});
test('dispatcher bounds concurrent manual sweeps and settles cancellation',async()=>{
  let calls=0,finishes=0;
  const d=createPublicationReceiptDispatcher(config,{ledger:{async claim(){calls++;return {receipt,token:'x'};},async finish(){finishes++;return true;}},
    client:{async deliver(r,{signal}){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('aborted');}}});
  const running=Array.from({length:4},()=>d.runOnce());await until(()=>calls===4);
  assert.equal(await d.runOnce(),null);assert.equal(d.status().inflight,4);await d.stop();await Promise.all(running);assert.equal(finishes,4);
});
test('dispatcher strictly records ACK or conflict without exposing upstream errors',async()=>{
  for(const mode of ['ack','bad ack','conflict','raw error']){
    let outcome;
    const d=createPublicationReceiptDispatcher(config,{ledger:{async claim(){return {receipt,token:'x'};},async finish(l,r){outcome=r;return true;}},
      client:{async deliver(){if(mode==='conflict')throw new PublicationReceiptError('conflict');if(mode==='raw error')throw new Error('private');
        return {...ack,...(mode==='bad ack'?{commitAllowed:true}:{})};}}});
    assert.deepEqual(await d.runOnce(),{eventId:'event',settled:true});
    assert.deepEqual(outcome,mode==='ack'?{kind:'delivered',localIntentCancelled:true}:{kind:mode==='conflict'?'conflict':'retry'});
    await d.stop();
  }
});
test('dispatcher records static storage failure and recovers on next automatic sweep',async()=>{
  let calls=0;
  const d=createPublicationReceiptDispatcher(config,{pollIntervalMs:10,ledger:{async claim(){calls++;if(calls===1)throw new Error('private');return null;}},client:{}});
  d.start();await until(()=>d.status().lastErrorCode==='skillhub.publication_receipt_storage');
  await until(()=>calls>=2);assert.equal(d.status().lastErrorCode,null);await d.stop();
});
