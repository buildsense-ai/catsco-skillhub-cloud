import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import {loadConfig} from '../../packages/config/index.js';
import {createDelegatedPublicationScheduler as scheduler} from '../../packages/publication-delegation/commit-scheduler.js';

const config=(extra={})=>loadConfig({nodeEnv:'test',publicationTasksEnabled:true,
  publicationPublishingEnabled:true,publicationDelegatedWorkerEnabled:true,workerPollMs:5,...extra});
const store={query(){throw Error('no SQL in lane unit test');},tx(){}};
const barrier=()=>{let release;return {promise:new Promise(r=>release=r),release:v=>release(v)};};

test('delegated lane disabled by default and fails closed on incomplete configuration',async()=>{
  for(const c of [config({publicationDelegatedWorkerEnabled:false}),
    {...config(),publicationDelegatedWorker:{}},config({publicationDelegatedWorkerEnabled:'true'}),
    config({publicationTasksEnabled:false}),config({publicationPublishingEnabled:false}),
    config({publicationTasksLeaseMs:1}),config({workerPollMs:0}),config({workerPollMs:60001})]) {
    let calls=0;const s=scheduler(c,{store,processCommit(){calls++;},warn(){}});
    assert.equal(s.enabled,false);assert.equal(await s.tick(),null);await s.run({once:true});await s.stop();
    assert.equal(calls,0);
  }
  assert.equal(scheduler(config(),{store:{},warn(){}}).enabled,false);
});

test('one active attempt shared by concurrent ticks, no waiting queue',async()=>{
  const hold=barrier();let calls=0;
  const s=scheduler(config(),{store,processCommit:async(c,o)=>{
    assert.equal(o.store,store);assert.equal(o.enabled,true);calls++;await hold.promise;return {taskId:'fixture'};
  }});
  const first=s.tick(),others=Array.from({length:20},()=>s.tick());
  await immediate();assert.equal(calls,1);
  hold.release();const results=await Promise.all([first,...others]);
  assert.equal(results.length,21);assert.equal(calls,1);
  await s.stop();assert.equal(await s.tick(),null);assert.equal(calls,1);
});

test('once drains due tasks but neither sleeps through backoff nor resets attempts',async()=>{
  let calls=0;const s=scheduler(config(),{store,processCommit:async()=>++calls<=2?{taskId:'fixture'}:null});
  await s.run({once:true});assert.equal(calls,3);await s.stop();
});

test('stop during claim allows current attempt to settle and prevents next claim',async()=>{
  const hold=barrier();let calls=0,finished=false;
  const s=scheduler(config(),{store,processCommit:async()=>{calls++;await hold.promise;return {taskId:'fixture'};}});
  const run=s.run();assert.equal(s.run(),run);await immediate();
  const stop=s.stop().then(()=>{finished=true;});await immediate();assert.equal(finished,false);
  hold.release();await stop;await run;assert.equal(calls,1);assert.equal(await s.tick(),null);
});

test('idle stop wakes a long poll without starting another operation',async()=>{
  let calls=0;const entered=barrier();
  const s=scheduler(config({workerPollMs:60000}),{store,processCommit:async()=>{calls++;entered.release();return null;}});
  const run=s.run();await entered.promise;await immediate();await s.stop();await run;
  assert.equal(calls,1);
});

test('database errors are redacted and deferred to the next poll, not hot-retried',async()=>{
  let calls=0;const warnings=[];
  const s=scheduler(config({workerPollMs:60000}),{store,warn:m=>warnings.push(m),
    processCommit:async()=>{calls++;throw Error('secret SQL path bearer');}});
  const run=s.run();await immediate();await immediate();assert.equal(calls,1);
  assert.deepEqual(warnings,['Delegated publication processing is unavailable.']);
  await s.stop();await run;
});

test('one-shot outage returns without claiming another task or leaking a rejection',async()=>{
  let calls=0;const s=scheduler(config(),{store,warn(){},processCommit(){calls++;throw Error('private');}});
  await s.run({once:true});assert.equal(calls,1);await s.stop();
});

test('independent lane does not wait for unrelated legacy IO',async()=>{
  const legacy=barrier(),delegated=barrier();let progressed=false;
  const unrelated=legacy.promise.then(()=>{progressed=true;});
  const s=scheduler(config(),{store,processCommit:async()=>{delegated.release();return null;}});
  await s.run({once:true});await delegated.promise;assert.equal(progressed,false);
  legacy.release();await unrelated;await s.stop();
});
