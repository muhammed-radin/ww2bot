/**
 * Connection control over HTTP for both connectors, using injected doubles so
 * no network, browser or real WhatsApp account is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeWhatsAppModule, createFakeCloudClientFactory } from '../helpers/fakeWhatsAppWeb.js';

const CLOUD_ENV = {
  META_ACCESS_TOKEN: 'test-access-token',
  META_PHONE_NUMBER_ID: '106540352242922',
};

test('the Cloud API connector verifies credentials and becomes ready', async (t) => {
  const app = await withApp(t, { env: CLOUD_ENV, cloudClientFactory: createFakeCloudClientFactory() });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    displayName: 'cloud',
    metadata: { phoneNumberId: '106540352242922' },
  });

  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.data.status, 'ready');
  assert.equal(connected.body.data.capabilities.official, true);

  const status = await app.request(`/api/v1/instances/${instance.id}/status`, { apiKey: key.plaintext });
  assert.equal(status.body.data.status, 'ready');
  assert.equal(status.body.data.details.verifiedName, 'Fixture Business');
});

test('a Cloud API instance without credentials fails with a connector error', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'cloud_api' });

  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 502);
  assert.equal(connected.body.error.code, 'CONNECTOR_ERROR');

  const status = await app.request(`/api/v1/instances/${instance.id}/status`, { apiKey: key.plaintext });
  assert.equal(status.body.data.status, 'error');
});

test('a Cloud API client failure is surfaced as a connector error', async (t) => {
  const app = await withApp(t, { env: CLOUD_ENV, cloudClientFactory: createFakeCloudClientFactory({ ok: false }) });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'cloud_api' });

  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 502);
  assert.equal(connected.body.error.code, 'CONNECTOR_ERROR');
});

test('an authorised web instance starts QR authentication', async (t) => {
  const app = await withApp(t, {
    libraryFactory: () => createFakeWhatsAppModule(),
    env: { QR_TTL_MS: '15000' },
  });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.data.status, 'awaiting_qr');
  assert.match(connected.body.data.qr.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(
    connected.body.data.eventsEndpoint,
    `/api/v1/instances/${instance.id}/auth/events`,
  );
  assert.ok(connected.body.data.note.includes('short-lived'));

  await app.container.connections.shutdown();
});

test('an authorised web instance returns a pairing code for its phone number', async (t) => {
  const app = await withApp(t, { libraryFactory: () => createFakeWhatsAppModule() });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const paired = await app.request(`/api/v1/instances/${instance.id}/connect/pairing-code`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { phoneNumber: '919812345678' },
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.body.data.pairingCode, 'ABCD1234');
  assert.equal(paired.body.data.reused, false);
  assert.equal(paired.body.data.status, 'awaiting_pairing_code');

  await app.container.connections.shutdown();
});

test('a malformed pairing phone number is rejected before any browser starts', async (t) => {
  const app = await withApp(t, { libraryFactory: () => createFakeWhatsAppModule() });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const bad = await app.request(`/api/v1/instances/${instance.id}/connect/pairing-code`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { phoneNumber: '+91 98123' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
});

test('connecting requires the auth:manage scope', async (t) => {
  const app = await withApp(t, { env: CLOUD_ENV, cloudClientFactory: createFakeCloudClientFactory() });
  const admin = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(admin.plaintext, { connector: 'cloud_api' });

  const reader = await app.issueKey({ scopes: ['instances:read'] });
  const denied = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: reader.plaintext,
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body.error.details.missingScopes, ['auth:manage']);
});
