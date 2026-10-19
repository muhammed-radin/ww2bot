/**
 * API key administration over HTTP: creation (shown once), listing, rotation,
 * revocation, scope gating and tenant isolation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';

test('a key is returned exactly once and never listed again', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });

  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: admin.plaintext,
    body: { name: 'reader', scopes: ['instances:read'] },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.data.apiKey, /^wak_[a-f0-9]{18}_[A-Za-z0-9_-]{43}$/);
  assert.ok(created.body.data.warning.includes('cannot be retrieved again'));
  assert.equal(created.body.data.key.keyHash, undefined);

  const listed = await app.request('/api/v1/api-keys', { apiKey: admin.plaintext });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.data.availableScopes));
  // The admin key used for this request is itself stored, so the listing holds
  // every key for the tenant; assert the created key is present as metadata only.
  const listedIds = listed.body.data.items.map((item) => item.keyId);
  assert.ok(listedIds.includes(created.body.data.key.keyId), 'the created key is listed by id');
  assert.equal(listed.body.data.items.every((item) => item.keyHash === undefined), true);
  assert.equal(listed.text.includes(created.body.data.apiKey), false, 'plaintext is never listed');

  // The new key actually authenticates.
  const check = await app.request('/api/v1/instances', { apiKey: created.body.data.apiKey });
  assert.equal(check.status, 200);
});

test('key administration requires the keys:manage scope', async (t) => {
  const app = await withApp(t);
  const reader = await app.issueKey({ scopes: ['instances:read'] });

  const listing = await app.request('/api/v1/api-keys', { apiKey: reader.plaintext });
  assert.equal(listing.status, 403);
  assert.equal(listing.body.error.code, 'FORBIDDEN');

  const create = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: reader.plaintext,
    body: { scopes: ['*'] },
  });
  assert.equal(create.status, 403);
});

test('a key cannot be created for another tenant', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ tenantId: 'tenant-a', scopes: ['*'] });
  const { status, body } = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: admin.plaintext,
    body: { scopes: ['*'], tenantId: 'tenant-b' },
  });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('invalid key creation payloads are rejected', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });

  const noScopes = await app.request('/api/v1/api-keys', { method: 'POST', apiKey: admin.plaintext, body: {} });
  assert.equal(noScopes.status, 400);

  const badScope = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: admin.plaintext,
    body: { scopes: ['nope'] },
  });
  assert.equal(badScope.status, 400);
});

test('rotation issues a new secret and revokes the old key', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });
  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: admin.plaintext,
    body: { name: 'to-rotate', scopes: ['instances:read'] },
  });
  const keyId = created.body.data.key.keyId;
  const oldKey = created.body.data.apiKey;

  const rotated = await app.request(`/api/v1/api-keys/${keyId}/rotate`, { method: 'POST', apiKey: admin.plaintext });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.data.apiKey, oldKey);
  assert.deepEqual(rotated.body.data.key.scopes, ['instances:read']);

  const oldRejected = await app.request('/api/v1/instances', { apiKey: oldKey });
  assert.equal(oldRejected.status, 401);

  const newWorks = await app.request('/api/v1/instances', { apiKey: rotated.body.data.apiKey });
  assert.equal(newWorks.status, 200);
});

test('revocation takes effect immediately', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });
  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: admin.plaintext,
    body: { name: 'to-revoke', scopes: ['instances:read'] },
  });
  const keyId = created.body.data.key.keyId;

  const revoked = await app.request(`/api/v1/api-keys/${keyId}`, { method: 'DELETE', apiKey: admin.plaintext });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.alreadyRevoked, false);

  const rejected = await app.request('/api/v1/instances', { apiKey: created.body.data.apiKey });
  assert.equal(rejected.status, 401);
});

test('a key cannot grant scopes it does not itself hold', async (t) => {
  const app = await withApp(t);
  // A service key that can administer keys but was never given auth:manage.
  const limited = await app.issueKey({ scopes: ['keys:manage', 'instances:read'] });

  const escalated = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: limited.plaintext,
    body: { name: 'sneaky', scopes: ['auth:manage'] },
  });
  assert.equal(escalated.status, 403);
  assert.equal(escalated.body.error.code, 'FORBIDDEN');

  const wildcard = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: limited.plaintext,
    body: { name: 'wild', scopes: ['*'] },
  });
  assert.equal(wildcard.status, 403);

  // It may still create keys within its own privileges.
  const allowed = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: limited.plaintext,
    body: { name: 'allowed', scopes: ['instances:read'] },
  });
  assert.equal(allowed.status, 201);
});

test('the owner key may create the narrow RazorBills service key', async (t) => {
  const app = await withApp(t);
  const owner = await app.issueKey({ scopes: ['*'] });
  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: owner.plaintext,
    body: { name: 'razorbills', scopes: ['messages:send'] },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.key.scopes, ['messages:send']);
  // The secret is returned exactly once and looks like a key.
  assert.match(created.body.data.apiKey, /^wak_[a-f0-9]{18}_[A-Za-z0-9_-]{43}$/);
});

test('a key from another tenant is invisible (404, never 403)', async (t) => {
  const app = await withApp(t);
  const adminA = await app.issueKey({ tenantId: 'tenant-a', scopes: ['*'] });
  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: adminA.plaintext,
    body: { name: 'a-key', scopes: ['instances:read'] },
  });
  const keyId = created.body.data.key.keyId;

  const adminB = await app.issueKey({ tenantId: 'tenant-b', scopes: ['*'] });
  const lookup = await app.request(`/api/v1/api-keys/${keyId}`, { apiKey: adminB.plaintext });
  assert.equal(lookup.status, 404);

  const rotate = await app.request(`/api/v1/api-keys/${keyId}/rotate`, { method: 'POST', apiKey: adminB.plaintext });
  assert.equal(rotate.status, 404);
});
