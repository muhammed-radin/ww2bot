/**
 * Graceful shutdown: connectors are torn down, browser slots released and the
 * teardown is safe to run more than once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

test('shutdown tears down connectors and releases browser slots', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  await app.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: key.plaintext });
  assert.equal(app.container.browserManager.size, 1);
  assert.ok(library.__lastClient().initialized);

  const firstRun = await app.container.connections.shutdown();
  assert.equal(firstRun.connectors, 1);
  assert.equal(firstRun.browsersClosed, 1);
  assert.equal(app.container.browserManager.size, 0);
  assert.equal(library.__clients.every((client) => client.destroyed), true);

  // Safe to run again: nothing to tear down.
  const secondRun = await app.container.connections.shutdown();
  assert.equal(secondRun.browsersClosed, 0);
});
