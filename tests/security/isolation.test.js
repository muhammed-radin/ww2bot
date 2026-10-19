/**
 * Tenant isolation and authorisation boundaries: cross-tenant access returns
 * 404 (never 403), instance allowlists are enforced, cursors are tamper-evident
 * and credentials are only accepted from the header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';

test('one tenant cannot see or read another tenant’s resources', async (t) => {
  const app = await withApp(t);
  const keyA = await app.issueKey({ tenantId: 'tenant-a', scopes: ['*'] });
  const keyB = await app.issueKey({ tenantId: 'tenant-b', scopes: ['*'] });

  const instanceA = await app.createInstance(keyA.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  // The listing is scoped: tenant B sees nothing of tenant A.
  const listB = await app.request('/api/v1/instances', { apiKey: keyB.plaintext });
  assert.equal(listB.body.data.items.length, 0);

  for (const path of [
    `/api/v1/instances/${instanceA.id}`,
    `/api/v1/instances/${instanceA.id}/status`,
    `/api/v1/instances/${instanceA.id}/session`,
  ]) {
    const response = await app.request(path, { apiKey: keyB.plaintext });
    assert.equal(response.status, 404, `${path} must hide cross-tenant instances`);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  }

  // Writing/deleting across tenants is likewise a 404, not a 403.
  const deleteCross = await app.request(`/api/v1/instances/${instanceA.id}`, {
    method: 'DELETE',
    apiKey: keyB.plaintext,
  });
  assert.equal(deleteCross.status, 404);
});

test('an instance allowlist limits a key to exactly its instances', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ tenantId: 'tenant-a', scopes: ['*'] });
  const allowed = await app.createInstance(admin.plaintext, { displayName: 'allowed' });
  const other = await app.createInstance(admin.plaintext, { displayName: 'other' });

  const restricted = await app.issueKey({
    tenantId: 'tenant-a',
    scopes: ['*'],
    allowedInstanceIds: [allowed.id],
  });

  const ok = await app.request(`/api/v1/instances/${allowed.id}`, { apiKey: restricted.plaintext });
  assert.equal(ok.status, 200);

  const denied = await app.request(`/api/v1/instances/${other.id}`, { apiKey: restricted.plaintext });
  assert.equal(denied.status, 404);

  const list = await app.request('/api/v1/instances', { apiKey: restricted.plaintext });
  assert.deepEqual(list.body.data.items.map((instance) => instance.id), [allowed.id]);
});

test('cursors are opaque and tamper-evident', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });
  await app.createInstance(key.plaintext, { displayName: 'second' });

  const page = await app.request('/api/v1/instances?limit=1', { apiKey: key.plaintext });
  const cursor = page.body.pagination.nextCursor;
  assert.equal(typeof cursor, 'string');

  // Flipping a character invalidates the signature.
  const tampered = `${cursor.slice(0, -3)}xyz`;
  const rejected = await app.request(`/api/v1/instances?limit=1&cursor=${encodeURIComponent(tampered)}`, {
    apiKey: key.plaintext,
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');

  // A valid cursor for one collection cannot be replayed against another.
  const crossCollection = await app.request(
    `/api/v1/instances/${instance.id}/chats?cursor=${encodeURIComponent(cursor)}`,
    { apiKey: key.plaintext },
  );
  assert.equal(crossCollection.status, 400);
});

test('API keys are accepted only from the header', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  const fromQuery = await app.request(`/api/v1/instances?apiKey=${encodeURIComponent(key.plaintext)}`);
  assert.equal(fromQuery.status, 401);

  const fromHeader = await app.request('/api/v1/instances', { apiKey: key.plaintext });
  assert.equal(fromHeader.status, 200);
});

test('instance identifiers are prefixed, high entropy and unique', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push((await app.createInstance(key.plaintext, { displayName: `instance ${index}` })).id);
  }

  for (const id of ids) assert.match(id, /^ins_[a-f0-9]{32}$/);
  assert.equal(new Set(ids).size, ids.length);
});

test('a key cannot administer another tenant’s keys', async (t) => {
  const app = await withApp(t);
  const keyA = await app.issueKey({ tenantId: 'tenant-a', scopes: ['*'] });
  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: keyA.plaintext,
    body: { name: 'a-key', scopes: ['instances:read'] },
  });
  const keyId = created.body.data.key.keyId;

  const keyB = await app.issueKey({ tenantId: 'tenant-b', scopes: ['*'] });
  const crossTenant = await app.request(`/api/v1/api-keys/${keyId}`, { apiKey: keyB.plaintext });
  assert.equal(crossTenant.status, 404);
});
