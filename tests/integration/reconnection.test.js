/**
 * Automatic reconnection supervisor over the persisted connection state machine.
 *
 * A connectable Cloud API instance is driven by an injected client double that
 * either succeeds or always fails, so backoff/exhaustion and restart recovery are
 * exercised without any network access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeCloudClientFactory } from '../helpers/fakeWhatsAppWeb.js';

const CLOUD_ENV = {
  META_ACCESS_TOKEN: 'test-access-token',
  META_PHONE_NUMBER_ID: '106540352242922',
};

const FAST_RECONNECT = {
  RECONNECT_ENABLED: 'true',
  RECONNECT_BASE_DELAY_MS: '100',
  RECONNECT_MAX_DELAY_MS: '1000',
  RECONNECT_JITTER: '0',
};

async function cloudInstance(app) {
  const owner = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(owner.plaintext, {
    connector: 'cloud_api',
    metadata: { phoneNumberId: '106540352242922' },
  });
  return { owner, instance };
}

test('a recoverable failure is scheduled, retried with backoff, then gives up into ERROR', async (t) => {
  const app = await withApp(t, {
    env: { ...CLOUD_ENV, ...FAST_RECONNECT, RECONNECT_MAX_ATTEMPTS: '3' },
    cloudClientFactory: createFakeCloudClientFactory({ ok: false }),
  });
  const { instance } = await cloudInstance(app);

  // Simulate the connector reporting an unexpected, recoverable drop.
  await app.container.events.publish(instance.id, 'connection.error', {
    status: 'error',
    recoverable: true,
    message: 'socket dropped',
  });

  const exhausted = await app.waitFor(
    async () => {
      const state = await app.container.connections.getConnectionState(instance.id);
      return state.state === 'ERROR' ? state : null;
    },
    { timeoutMs: 6000, intervalMs: 20 },
  );

  assert.equal(exhausted.state, 'ERROR');
  assert.match(exhausted.lastError, /gave up|exhausted/i);

  // The instance list reflects the terminal state so the owner sees it.
  const reader = await app.issueKey({ scopes: ['instances:read'] });
  const rowStatus = await app.waitFor(
    async () => {
      const list = await app.request('/api/v1/instances', { apiKey: reader.plaintext });
      const row = list.body.data.items.find((item) => item.id === instance.id);
      return row?.status === 'error' ? row.status : null;
    },
    { timeoutMs: 3000, intervalMs: 20 },
  );
  assert.equal(rowStatus, 'error');
});

test('a non-recoverable error is not retried', async (t) => {
  const app = await withApp(t, {
    env: { ...CLOUD_ENV, ...FAST_RECONNECT },
    cloudClientFactory: createFakeCloudClientFactory({ ok: false }),
  });
  const { instance } = await cloudInstance(app);

  await app.container.events.publish(instance.id, 'connection.error', {
    status: 'error',
    recoverable: false,
    message: 'credentials rejected',
  });

  // Give the supervisor a chance to (incorrectly) schedule anything.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = await app.container.connections.getConnectionState(instance.id);
  assert.equal(state.state, 'ERROR');
  assert.equal(state.attempt, 0, 'no reconnect attempt was counted');
  assert.equal(app.container.reconnection.timers.size, 0, 'no reconnect timer was armed');
});

test('reconnection is disabled when RECONNECT_ENABLED is false', async (t) => {
  const app = await withApp(t, {
    env: { ...CLOUD_ENV, RECONNECT_ENABLED: 'false' },
    cloudClientFactory: createFakeCloudClientFactory({ ok: false }),
  });
  const { instance } = await cloudInstance(app);

  await app.container.events.publish(instance.id, 'connection.error', { status: 'error', recoverable: true });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const state = await app.container.connections.getConnectionState(instance.id);
  assert.notEqual(state.state, 'RECONNECTING');
  assert.equal(app.container.reconnection.timers.size, 0);
});
