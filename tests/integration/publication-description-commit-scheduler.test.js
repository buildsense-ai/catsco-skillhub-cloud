import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { loadConfig } from '../../packages/config/index.js';
import { createPublicationDescriptionReleaseScheduler as scheduler } from '../../packages/publication-description-derivations/commit-scheduler.js';

const config = extra => loadConfig({ nodeEnv: 'test', publicationTasksEnabled: true,
  publicationPublishingEnabled: true, publicationDescriptionPlanEnabled: true,
  publicationDescriptionDerivationEnabled: true, publicationDescriptionCommitWorkerEnabled: true,
  workerPollMs: 5, ...extra });
const store = { query() {}, tx() {} };
const barrier = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release }; };
const worker = once => ({ once });

test('description release scheduler is default-off and requires both independent gates', async () => {
  for (const value of [
    config({ publicationDescriptionPlanEnabled: false }),
    config({ publicationDescriptionDerivationEnabled: false }),
    config({ publicationDescriptionCommitWorkerEnabled: false }),
    config({ publicationTasksEnabled: false }),
    config({ publicationPublishingEnabled: false }),
    config({ publicationTasksLeaseMs: 1 }),
    config({ workerPollMs: 0 }),
    config({ workerPollMs: 60001 })
  ]) {
    let calls = 0;
    const lane = scheduler(value, { store, prepareWorker: worker(() => { calls++; }),
      commitWorker: worker(() => { calls++; }), warn() {} });
    assert.equal(lane.enabled, false);
    assert.equal(await lane.tick(), null);
    await lane.run({ once: true });
    await lane.stop();
    assert.equal(calls, 0);
  }
  assert.equal(scheduler(config(), { store: {}, warn() {} }).enabled, false);
});

test('description scheduler prepares before completion and drains due work in one-shot mode', async () => {
  const order = [];
  let preparations = 0, completions = 0;
  const lane = scheduler(config(), { store,
    prepareWorker: worker(async () => { order.push('prepare'); return ++preparations === 1 ? { state: 'committing' } : null; }),
    commitWorker: worker(async () => { order.push('complete'); return ++completions === 1 ? { state: 'published' } : null; })
  });
  await lane.run({ once: true });
  assert.deepEqual(order, ['prepare', 'complete', 'prepare', 'complete']);
  await lane.stop();
});

test('description scheduler coalesces concurrent ticks and stop awaits the active attempt', async () => {
  const hold = barrier();
  let calls = 0, stopped = false;
  const lane = scheduler(config(), { store,
    prepareWorker: worker(async () => { calls++; await hold.promise; return null; }),
    commitWorker: worker(async () => null)
  });
  const first = lane.tick();
  const concurrent = Array.from({ length: 12 }, () => lane.tick());
  await immediate();
  assert.equal(calls, 1);
  const stopping = lane.stop().then(() => { stopped = true; });
  await immediate();
  assert.equal(stopped, false);
  hold.release();
  await Promise.all([first, ...concurrent, stopping]);
  assert.equal(stopped, true);
  assert.equal(await lane.tick(), null);
  assert.equal(calls, 1);
});

test('description scheduler redacts processing errors and once mode does not hot retry', async () => {
  const warnings = [];
  let calls = 0;
  const lane = scheduler(config(), { store, warn: message => warnings.push(message),
    prepareWorker: worker(async () => { calls++; throw new Error('secret database path'); }),
    commitWorker: worker(async () => { calls++; return null; })
  });
  await lane.run({ once: true });
  await lane.stop();
  assert.equal(calls, 1);
  assert.deepEqual(warnings, ['Description release processing is unavailable.']);
});
