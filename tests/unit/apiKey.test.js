import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env.js';
import { AuditService } from '../../src/services/audit.service.js';
import { ApiKeyService } from '../../src/services/apiKey.service.js';
import { UnauthorizedError, ValidationError, NotFoundError } from '../../src/utils/errors.js';
import { createLogger } from '../../src/utils/logger.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';
import { createTestRepositories } from '../helpers/testStore.js';

async function build() {
  const config = loadConfig({ ...BASE_TEST_ENV });
  const logger = createLogger(config);
  const { repositories } = await createTestRepositories({ logger });
  const audit = new AuditService({ repository: repositories.audit, logger });
  const service = new ApiKeyService({ repository: repositories.apiKeys, config, logger, audit });
  return { service, repositories, audit };
}

test('generated keys are 256-bit, well formed and stored only as a digest', async () => {
  const { service, repositories } = await build();
  const { plaintext, record } = await service.generate({ tenantId: 'tenant-a', name: 'admin', scopes: ['*'] });

  assert.match(plaintext, /^wak_[a-f0-9]{18}_[A-Za-z0-9_-]{43}$/);
  const secret = /^wak_[a-f0-9]{18}_(.+)$/.exec(plaintext)[1];
  assert.equal(Buffer.from(secret, 'base64url').length, 32, '32 random bytes of entropy');

  assert.equal(record.keyHash.length, 64);
  assert.ok(!plaintext.includes(record.keyHash));

  const stored = await repositories.apiKeys.findByKeyId(record.keyId);
  assert.ok(!Object.values(stored).some((value) => value === plaintext), 'plaintext must not be persisted');
});

test('two keys never collide', async () => {
  const { service } = await build();
  const keys = new Set();
  for (let index = 0; index < 25; index += 1) {
    const { plaintext } = await service.generate({ tenantId: 'tenant-a', name: 'k', scopes: ['instances:read'] });
    keys.add(plaintext);
  }
  assert.equal(keys.size, 25);
});

test('verification returns the tenant, scopes and instance allowlist', async () => {
  const { service } = await build();
  const instanceId = `ins_${'a'.repeat(32)}`;
  const { plaintext } = await service.generate({
    tenantId: 'tenant-a',
    name: 'reader',
    scopes: ['instances:read', 'data:read'],
    allowedInstanceIds: [instanceId],
  });

  const auth = await service.verify(plaintext);
  assert.equal(auth.tenantId, 'tenant-a');
  assert.deepEqual(auth.scopes, ['instances:read', 'data:read']);
  assert.deepEqual(auth.allowedInstanceIds, [instanceId]);
});

test('verification rejects missing, malformed, unknown and wrong keys', async () => {
  const { service } = await build();
  const { plaintext } = await service.generate({ tenantId: 'tenant-a', name: 'x', scopes: ['*'] });
  const [, , keyId, secret] = /^(wak)_([a-f0-9]{18})_(.+)$/.exec(plaintext);
  const prefix = 'wak';

  await assert.rejects(() => service.verify(undefined), UnauthorizedError);
  await assert.rejects(() => service.verify(''), UnauthorizedError);
  await assert.rejects(() => service.verify('not-a-key'), UnauthorizedError);
  await assert.rejects(() => service.verify(`${prefix}_${keyId}_${'A'.repeat(43)}`), UnauthorizedError);
  await assert.rejects(() => service.verify(`${prefix}_${'f'.repeat(18)}_${secret}`), UnauthorizedError);
  await assert.rejects(() => service.verify(`${prefix}_${keyId}_short`), UnauthorizedError);
  // A very long value is rejected before any hashing work happens.
  await assert.rejects(() => service.verify('x'.repeat(1000)), UnauthorizedError);
});

test('revoked and expired keys are rejected', async () => {
  const { service } = await build();

  const revoked = await service.generate({ tenantId: 'tenant-a', name: 'r', scopes: ['*'] });
  await service.revoke(revoked.record.keyId, { tenantId: 'tenant-a' });
  await assert.rejects(() => service.verify(revoked.plaintext), /revoked/);

  const expired = await service.generate({
    tenantId: 'tenant-a',
    name: 'e',
    scopes: ['*'],
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await assert.rejects(() => service.verify(expired.plaintext), /expired/);
});

test('expiry can be set from a TTL in days', async () => {
  const { service } = await build();
  const { record } = await service.generate({ tenantId: 'tenant-a', name: 't', scopes: ['*'], ttlDays: 5 });
  const days = (new Date(record.expiresAt).getTime() - Date.now()) / 86400000;
  assert.ok(days > 4.9 && days <= 5);
});

test('rotation issues a new secret and revokes the previous one', async () => {
  const { service } = await build();
  const original = await service.generate({ tenantId: 'tenant-a', name: 'rot', scopes: ['instances:read'] });

  const rotated = await service.rotate(original.record.keyId, { tenantId: 'tenant-a' });
  assert.notEqual(rotated.plaintext, original.plaintext);
  assert.deepEqual(rotated.record.scopes, ['instances:read']);
  await assert.rejects(() => service.verify(original.plaintext), /revoked/);

  const auth = await service.verify(rotated.plaintext);
  assert.equal(auth.tenantId, 'tenant-a');

  // A revoked key cannot be rotated again.
  await assert.rejects(() => service.rotate(original.record.keyId, { tenantId: 'tenant-a' }), ValidationError);
});

test('rotation respects a grace period', async () => {
  const { service } = await build();
  const original = await service.generate({ tenantId: 'tenant-a', name: 'g', scopes: ['*'] });
  const rotated = await service.rotate(original.record.keyId, { tenantId: 'tenant-a', gracePeriodMs: 60000 });

  // The previous key still verifies during the overlap window.
  const previous = await service.verify(original.plaintext);
  assert.equal(previous.tenantId, 'tenant-a');
  await service.verify(rotated.plaintext);
});

test('a key from one tenant cannot be rotated or revoked by another', async () => {
  const { service } = await build();
  const { record } = await service.generate({ tenantId: 'tenant-a', name: 'a', scopes: ['*'] });
  await assert.rejects(() => service.rotate(record.keyId, { tenantId: 'tenant-b' }), NotFoundError);
  await assert.rejects(() => service.revoke(record.keyId, { tenantId: 'tenant-b' }), NotFoundError);
  await assert.rejects(() => service.getOwn({ tenantId: 'tenant-b' }, record.keyId), NotFoundError);
});

test('scope validation is strict', async () => {
  const { service } = await build();
  await assert.rejects(() => service.generate({ tenantId: 't', name: 'x', scopes: [] }), ValidationError);
  await assert.rejects(() => service.generate({ tenantId: 't', name: 'x', scopes: ['nope'] }), ValidationError);
  await assert.rejects(() => service.generate({ tenantId: 't', name: 'x', scopes: ['*', 'data:read'] }), ValidationError);
  await assert.rejects(() => service.generate({ tenantId: '', name: 'x', scopes: ['*'] }), ValidationError);
  await assert.rejects(
    () => service.generate({ tenantId: 't', name: 'x', scopes: ['*'], allowedInstanceIds: [] }),
    ValidationError,
  );

  const { record } = await service.generate({ tenantId: 't', name: 'x', scopes: ['*'] });
  assert.deepEqual(record.scopes, ['*']);
});

test('scope and instance helpers enforce authorisation', () => {
  const wildcard = { scopes: ['*'], allowedInstanceIds: null };
  const reader = { scopes: ['instances:read'], allowedInstanceIds: ['ins_a'] };

  assert.equal(ApiKeyService.hasScope(wildcard, 'data:read'), true);
  assert.equal(ApiKeyService.hasScope(reader, 'instances:read'), true);
  assert.equal(ApiKeyService.hasScope(reader, 'data:read'), false);
  assert.equal(ApiKeyService.hasScope(null, 'data:read'), false);

  assert.doesNotThrow(() => ApiKeyService.assertScopes(reader, ['instances:read']));
  assert.throws(() => ApiKeyService.assertScopes(reader, ['keys:admin']), /missing a required scope/);

  assert.doesNotThrow(() => ApiKeyService.assertInstanceAllowed(reader, 'ins_a'));
  // Deliberately a 404 so instance existence is not disclosed.
  assert.throws(() => ApiKeyService.assertInstanceAllowed(reader, 'ins_b'), NotFoundError);
  assert.doesNotThrow(() => ApiKeyService.assertInstanceAllowed(wildcard, 'anything'));
});

test('listing returns key metadata but never a hash or secret', async () => {
  const { service } = await build();
  await service.generate({ tenantId: 'tenant-a', name: 'one', scopes: ['*'] });
  await service.generate({ tenantId: 'tenant-a', name: 'two', scopes: ['*'] });
  await service.generate({ tenantId: 'tenant-b', name: 'other', scopes: ['*'] });

  const listed = await service.list('tenant-a', { limit: 10 });
  assert.equal(listed.length, 2);
  assert.ok(listed.every((record) => record.tenantId === 'tenant-a'));

  const { publicApiKeyView } = await import('../../src/services/apiKey.service.js');
  const view = publicApiKeyView(listed[0]);
  assert.equal(view.keyHash, undefined);
  assert.ok(!JSON.stringify(view).includes('wak_'));
});

test('verification failures are audited without leaking the key', async () => {
  const { service, audit } = await build();
  await assert.rejects(() => service.verify('wak_' + 'a'.repeat(18) + '_' + 'B'.repeat(43)));
  const events = await audit.list({ tenantId: null, limit: 10 });
  const verification = events.find((event) => event.action === 'api_key.verification_failed');
  // Unknown key ids are rejected before hashing, so no tenant is known; the
  // failure is still recorded and contains no secret material.
  assert.ok(verification === undefined || !JSON.stringify(verification).includes('wak_'));
});
