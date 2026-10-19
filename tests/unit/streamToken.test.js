import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env.js';
import { StreamTokenService } from '../../src/services/streamToken.service.js';
import { UnauthorizedError } from '../../src/utils/errors.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';

function build() {
  const config = loadConfig({ ...BASE_TEST_ENV });
  return { service: new StreamTokenService({ config }), config };
}

const auth = {
  keyId: 'abc123abc123abc123',
  tenantId: 'tenant-a',
  scopes: ['connection:read'],
  allowedInstanceIds: null,
};

test('a stream token is issued bound to a key and instance', async () => {
  const { service } = build();
  const issued = await service.issue({ auth, instanceId: 'ins_' + 'a'.repeat(32) });

  assert.ok(issued.token.length >= 40);
  assert.ok(new Date(issued.expiresAt).getTime() > Date.now());

  const consumed = await service.consume(issued.token);
  assert.equal(consumed.tenantId, 'tenant-a');
  assert.equal(consumed.instanceId, 'ins_' + 'a'.repeat(32));
  assert.deepEqual(consumed.scopes, ['connection:read']);
});

test('a stream token can only be used once', async () => {
  const { service } = build();
  const { token } = await service.issue({ auth, instanceId: 'ins_' + 'a'.repeat(32) });
  await service.consume(token);
  await assert.rejects(() => service.consume(token), UnauthorizedError);
});

test('garbage tokens are rejected without touching the store', async () => {
  const { service } = build();
  await assert.rejects(() => service.consume(undefined), UnauthorizedError);
  await assert.rejects(() => service.consume('short'), UnauthorizedError);
  await assert.rejects(() => service.consume('x'.repeat(300)), UnauthorizedError);
  await assert.rejects(() => service.consume('y'.repeat(50)), UnauthorizedError);
});

test('an expired token is rejected', async () => {
  const { service } = build();
  const { token } = await service.issue({ auth, instanceId: 'ins_' + 'a'.repeat(32) });

  // Fast-forward the stored expiry instead of waiting for the TTL.
  for (const payload of service.memory.values()) payload.expiresAt = Date.now() - 1000;
  await assert.rejects(() => service.consume(token), /expired/);
});

test('tokens do not outlive their configured TTL and are pruned', async () => {
  const { service, config } = build();
  for (let index = 0; index < 20; index += 1) {
    await service.issue({ auth, instanceId: 'ins_' + 'a'.repeat(32) });
  }
  assert.equal(service.memory.size, 20);
  for (const payload of service.memory.values()) payload.expiresAt = Date.now() - 1;
  await service.issue({ auth, instanceId: 'ins_' + 'a'.repeat(32) });
  assert.equal(service.memory.size, 1, 'expired tokens are pruned on issue');
  assert.equal(config.events.streamTokenTtlMs, 60000);
});

test('the raw token is never stored, only its digest', async () => {
  const { service } = build();
  const { token } = await service.issue({ auth, instanceId: 'ins_' + 'a'.repeat(32) });
  for (const key of service.memory.keys()) {
    assert.ok(!key.includes(token));
    assert.match(key, /^stt:[a-f0-9]{64}$/);
  }
});
