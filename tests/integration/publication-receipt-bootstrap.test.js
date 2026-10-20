import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../packages/config/index.js';
import { createPublicationReceiptDelivery } from '../../apps/worker/worker.js';

const valid = {
  publicationReceiptDeliveryEnabled: true,
  publicationReceiptDeliveryIssuer: 'https://cats.example',
  publicationReceiptDeliveryAudience: 'https://hub.example',
  publicationReceiptDeliveryPeerSecret: '1'.repeat(64),
  publicationReceiptDeliveryPollMs: 25
};

test('receipt delivery remains inert by default', async () => {
  let touched = false;
  const config = loadConfig({ nodeEnv: 'test' });
  const delivery = createPublicationReceiptDelivery(config, {
    tx() {
      touched = true;
      throw new Error('disabled lane touched storage');
    }
  });
  assert.equal(delivery.status().started, false);
  assert.equal(await delivery.runOnce(), null);
  delivery.start();
  assert.equal(delivery.status().started, false);
  await delivery.stop();
  assert.equal(touched, false);
});

test('enabled receipt delivery uses the explicit peer configuration', async () => {
  const config = loadConfig({ nodeEnv: 'test', ...valid });
  const receipt = {
    schemaVersion: 1,
    entryRequestId: 'pubentry_1234567890abcdef1234567890abcdef',
    candidateRevision: 1,
    acceptanceEpoch: 1,
    requestHash: 'a'.repeat(64),
    sourceSnapshotHash: 'b'.repeat(64),
    requestBytes: 12,
    delegationId: 'pubgrant_' + 'c'.repeat(32),
    idempotencyKey: 'pubcandidate_' + 'd'.repeat(32),
    taskId: 'pubtask_12345678-1234-4123-8123-123456789abc',
    eventId: 'pubevent_12345678-1234-4123-8123-123456789abc'
  };
  let delivered = 0;
  const delivery = createPublicationReceiptDelivery(config, {
    tx() {
      throw new Error('store should be replaced by the injected ledger');
    }
  }, {
    ledger: {
      async claim() {
        if (delivered) return null;
        return { receipt, token: 'lease' };
      },
      async finish(_lease, outcome) {
        assert.deepEqual(outcome, { kind: 'delivered', localIntentCancelled: false });
        delivered++;
        return true;
      }
    },
    client: {
      async deliver(value) {
        assert.deepEqual(value, receipt);
        return {
          schemaVersion: 1,
          recorded: true,
          entryRequestId: receipt.entryRequestId,
          taskId: receipt.taskId,
          eventId: receipt.eventId,
          localIntentCancelled: false,
          commitAllowed: false
        };
      }
    }
  });
  assert.equal(delivery.status().started, false);
  assert.deepEqual(await delivery.runOnce(), { eventId: receipt.eventId, settled: true });
  assert.equal(delivered, 1);
  await delivery.stop();
});
