/**
 * Instance CRUD, scope enforcement and cursor pagination over HTTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, withApp } from '../helpers/testApp.js';

test('an instance is created with honest, discoverable capabilities', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  const { status, body } = await app.request('/api/v1/instances', {
    method: 'POST',
    apiKey: key.plaintext,
    body: { connector: 'cloud_api', displayName: 'Support line', metadata: { phoneNumberId: '106540352242922' } },
  });

  assert.equal(status, 201);
  assert.match(body.data.instance.id, /^ins_[a-f0-9]{32}$/);
  assert.equal(body.data.instance.connector, 'cloud_api');
  assert.equal(body.data.instance.status, 'created');
  assert.equal(body.data.capabilities.official, true);
  assert.equal(body.data.capabilities.qrAuth, false);
  assert.equal(body.data.capabilities.supportedEndpoints['POST /api/v1/instances/:instanceId/connect/qr'], false);
});

test('the web connector can be created only when explicitly enabled', async (t) => {
  const enabled = await withApp(t);
  const key = await enabled.issueKey({ scopes: ['*'] });
  const created = await enabled.request('/api/v1/instances', {
    method: 'POST',
    apiKey: key.plaintext,
    body: { connector: 'web', displayName: 'Web link' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.capabilities.official, false);
  assert.equal(created.body.data.capabilities.authorizationReference, 'TEST-AUTHZ-REFERENCE-0001');

  const disabled = await startTestApp({
    env: { ENABLE_WHATSAPP_WEB_CONNECTOR: 'false', WHATSAPP_WEB_AUTHORIZATION_REFERENCE: '' },
  });
  t.after(() => disabled.close());
  const disabledKey = await disabled.issueKey({ scopes: ['*'] });
  const rejected = await disabled.request('/api/v1/instances', {
    method: 'POST',
    apiKey: disabledKey.plaintext,
    body: { connector: 'web' },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'CONNECTOR_DISABLED');
});

test('invalid creation payloads are rejected with a validation error', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  const badConnector = await app.request('/api/v1/instances', {
    method: 'POST',
    apiKey: key.plaintext,
    body: { connector: 'telepathy' },
  });
  assert.equal(badConnector.status, 400);
  assert.equal(badConnector.body.error.code, 'VALIDATION_ERROR');

  const badPhone = await app.request('/api/v1/instances', {
    method: 'POST',
    apiKey: key.plaintext,
    body: { connector: 'cloud_api', metadata: { phoneNumberId: 'not-numeric' } },
  });
  assert.equal(badPhone.status, 400);
});

test('scope requirements are enforced per operation', async (t) => {
  const app = await withApp(t);
  const reader = await app.issueKey({ scopes: ['instances:read'] });

  const create = await app.request('/api/v1/instances', { method: 'POST', apiKey: reader.plaintext, body: {} });
  assert.equal(create.status, 403);
  assert.deepEqual(create.body.error.details.missingScopes, ['auth:manage']);

  const list = await app.request('/api/v1/instances', { apiKey: reader.plaintext });
  assert.equal(list.status, 200);
});

test('listing pages through a tenant with an opaque, reusable cursor', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  for (const name of ['one', 'two', 'three']) {
    await app.request('/api/v1/instances', { method: 'POST', apiKey: key.plaintext, body: { displayName: name } });
  }

  const first = await app.request('/api/v1/instances?limit=2', { apiKey: key.plaintext });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.items.length, 2);
  assert.equal(first.body.pagination.hasMore, true);
  assert.equal(typeof first.body.pagination.nextCursor, 'string');

  const second = await app.request(
    `/api/v1/instances?limit=2&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`,
    { apiKey: key.plaintext },
  );
  assert.equal(second.body.data.items.length, 1);
  assert.equal(second.body.pagination.hasMore, false);
  assert.equal(second.body.pagination.nextCursor, null);

  const ids = new Set([...first.body.data.items, ...second.body.data.items].map((instance) => instance.id));
  assert.equal(ids.size, 3, 'every instance appears exactly once across pages');
});

test('read detail, status and capabilities reflect the instance', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  const detail = await app.request(`/api/v1/instances/${instance.id}`, { apiKey: key.plaintext });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.instance.id, instance.id);

  const status = await app.request(`/api/v1/instances/${instance.id}/status`, { apiKey: key.plaintext });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.live, false);

  const capabilities = await app.request(`/api/v1/instances/${instance.id}/capabilities`, { apiKey: key.plaintext });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.data.connector, 'cloud_api');
});

test('unknown instance ids return 404', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const missing = `ins_${'f'.repeat(32)}`;
  const { status, body } = await app.request(`/api/v1/instances/${missing}`, { apiKey: key.plaintext });
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('deleting an instance reports what was cleaned up', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  const deleted = await app.request(`/api/v1/instances/${instance.id}`, { method: 'DELETE', apiKey: key.plaintext });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.deleted, true);
  assert.equal(typeof deleted.body.data.purged.messages, 'number');

  const after = await app.request(`/api/v1/instances/${instance.id}`, { apiKey: key.plaintext });
  assert.equal(after.status, 404);
});

test('the connectors catalogue documents both connectors', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const { status, body } = await app.request('/api/v1/connectors', { apiKey: key.plaintext });

  assert.equal(status, 200);
  assert.equal(body.data.default, 'cloud_api');
  assert.equal(body.data.connectors.cloud_api.official, true);
  assert.equal(body.data.connectors.web.official, false);
  assert.ok(body.data.notes.some((note) => note.includes('disabled by default')));
});
