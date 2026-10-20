import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestRepositories } from '../helpers/testStore.js';

test('keyless deliveries do not collapse into the first keyless record', async () => {
  const { repositories } = await createTestRepositories();
  const instanceId = `ins_${'a'.repeat(32)}`;
  const base = {
    instanceId,
    tenantId: 'tenant-a',
    idempotencyKeyHash: null,
    recipient: '131355503402@c.us',
    status: 'sent',
    errorCode: null,
    createdAt: new Date('2026-10-20T12:00:00.000Z'),
    keyId: 'key-fixture',
  };

  const first = await repositories.deliveries.record({
    ...base,
    id: 'dlv_first',
    providerMessageId: 'provider-first',
  });
  const second = await repositories.deliveries.record({
    ...base,
    id: 'dlv_second',
    providerMessageId: 'provider-second',
  });

  assert.equal(first.id, 'dlv_first');
  assert.equal(second.id, 'dlv_second');
  assert.equal(second.providerMessageId, 'provider-second');
  assert.equal((await repositories.deliveries.list(instanceId)).length, 2);
});

test('an explicit idempotency key still replays the existing delivery', async () => {
  const { repositories } = await createTestRepositories();
  const instanceId = `ins_${'b'.repeat(32)}`;
  const base = {
    instanceId,
    tenantId: 'tenant-a',
    idempotencyKeyHash: 'fixture-hash',
    recipient: '131355503402@c.us',
    status: 'sent',
    errorCode: null,
    createdAt: new Date('2026-10-20T12:00:00.000Z'),
    keyId: 'key-fixture',
  };

  const first = await repositories.deliveries.record({
    ...base,
    id: 'dlv_first',
    providerMessageId: 'provider-first',
  });
  const replay = await repositories.deliveries.record({
    ...base,
    id: 'dlv_second',
    providerMessageId: 'provider-second',
  });

  assert.equal(first.id, 'dlv_first');
  assert.equal(replay.id, 'dlv_first');
  assert.equal(replay.providerMessageId, 'provider-first');
  assert.equal((await repositories.deliveries.list(instanceId)).length, 1);
});
