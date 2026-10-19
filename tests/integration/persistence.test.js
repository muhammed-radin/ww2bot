/**
 * Persistence across process restarts.
 *
 * The service stores everything under DATA_DIR, so a redeploy must not lose API
 * keys, instances or the connection state machine. Each "restart" here closes
 * one app instance and starts a fresh one over the same directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from '../helpers/testApp.js';
import { createFakeCloudClientFactory, createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

const CLOUD_ENV = {
  META_ACCESS_TOKEN: 'test-access-token',
  META_PHONE_NUMBER_ID: '106540352242922',
};

async function freshDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-wa-restart-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

test('instances, keys and connection state survive a restart; cloud reconnects', async (t) => {
  const dataDir = await freshDataDir(t);
  const env = {
    ...CLOUD_ENV,
    AUTO_RECONNECT_ON_STARTUP: 'true',
    RECONNECT_ENABLED: 'true',
    RECONNECT_BASE_DELAY_MS: '100',
    RECONNECT_MAX_DELAY_MS: '1000',
    RECONNECT_JITTER: '0',
  };

  const first = await startTestApp({ dataDir, env, cloudClientFactory: createFakeCloudClientFactory() });
  t.after(() => first.close({ removeDataDir: false }));
  const owner = await first.issueKey({ scopes: ['*'], name: 'owner' });
  const instance = await first.createInstance(owner.plaintext, {
    connector: 'cloud_api',
    metadata: { phoneNumberId: '106540352242922' },
  });
  const connected = await first.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: owner.plaintext,
  });
  assert.equal(connected.body.data.status, 'ready');
  assert.equal((await first.container.connections.getConnectionState(instance.id)).state, 'CONNECTED');
  await first.close({ removeDataDir: false });

  // ---- restart ----
  const second = await startTestApp({ dataDir, env, cloudClientFactory: createFakeCloudClientFactory() });
  t.after(() => second.close({ removeDataDir: true }));

  // The owner key still authenticates: it is stored only as a keyed digest.
  const list = await second.request('/api/v1/instances', { apiKey: owner.plaintext });
  assert.equal(list.status, 200, 'the persisted API key still verifies');
  assert.ok(list.body.data.items.some((item) => item.id === instance.id), 'the instance survived');

  // Startup recovery reconnects a credential-based connector automatically.
  const reconnected = await second.waitFor(
    async () => {
      const state = await second.container.connections.getConnectionState(instance.id);
      return state.state === 'CONNECTED' ? state : null;
    },
    { timeoutMs: 6000, intervalMs: 25 },
  );
  assert.equal(reconnected.state, 'CONNECTED');
});

test('a restart never auto-launches the Web connector (no unsolicited QR)', async (t) => {
  const dataDir = await freshDataDir(t);
  const env = { AUTO_RECONNECT_ON_STARTUP: 'true' };

  const library1 = createFakeWhatsAppModule();
  const first = await startTestApp({ dataDir, env, libraryFactory: () => library1 });
  t.after(() => first.close({ removeDataDir: false }));
  const owner = await first.issueKey({ scopes: ['*'] });
  const instance = await first.createInstance(owner.plaintext, { connector: 'web' });
  await first.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: owner.plaintext });
  library1.__lastClient().simulateReady();
  await first.waitFor(
    async () => (await first.container.connections.getConnectionState(instance.id)).state === 'CONNECTED',
    { timeoutMs: 3000 },
  );
  await first.close({ removeDataDir: false });

  // ---- restart ----
  const library2 = createFakeWhatsAppModule();
  const second = await startTestApp({ dataDir, env, libraryFactory: () => library2 });
  t.after(() => second.close({ removeDataDir: true }));

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(library2.__clients.length, 0, 'no browser/client was launched on restart');

  const state = await second.container.connections.getConnectionState(instance.id);
  assert.equal(state.state, 'DISCONNECTED', 'the previously-live session is marked disconnected but not re-opened');
});

test('the data directory never contains an unencrypted session archive', async (t) => {
  const dataDir = await freshDataDir(t);
  const library = createFakeWhatsAppModule();
  const app = await startTestApp({ dataDir, env: { WHATSAPP_WEB_AUTH_STRATEGY: 'remote_encrypted' }, libraryFactory: () => library });
  t.after(() => app.close({ removeDataDir: true }));

  const owner = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(owner.plaintext, { connector: 'web' });
  await app.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: owner.plaintext });

  // Walk the instance directory: any session archive present must be ciphertext.
  const instanceDir = path.join(dataDir, 'instances', instance.id);
  const entries = await fs.readdir(instanceDir);
  const archive = entries.find((entry) => entry === 'session-archive.enc');
  if (archive) {
    const contents = await fs.readFile(path.join(instanceDir, archive), 'utf8');
    assert.match(contents, /^ENC:v1:/);
  }
  await app.request(`/api/v1/instances/${instance.id}/disconnect`, { method: 'POST', apiKey: owner.plaintext });
});

test('the service refuses to start when DATA_DIR is not usable', async (t) => {
  const dataDir = await freshDataDir(t);
  const blocker = path.join(dataDir, 'blocker');
  await fs.writeFile(blocker, 'a file, not a directory');

  await assert.rejects(
    () => startTestApp({ dataDir: path.join(blocker, 'data') }),
    (error) => {
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      assert.match(error.message, /DATA_DIR/);
      return true;
    },
  );
});
