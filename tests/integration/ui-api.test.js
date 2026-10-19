/**
 * Owner dashboard read endpoints.
 *
 * Exercises the aggregation/filtering the ww2web Logs, Messaging and
 * Configuration pages depend on, against real file-backed state.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TEST_KEY_RING, TEST_PEPPER } from '../helpers/testApp.js';

describe('owner dashboard endpoints', () => {
  let app;
  let owner;

  before(async () => {
    app = await startTestApp();
    owner = await app.issueKey({ tenantId: 'tenant-ui', scopes: ['*'], name: 'owner' });
    await app.createInstance(owner.plaintext, { connector: 'cloud_api', displayName: 'first' });
    await app.createInstance(owner.plaintext, { connector: 'cloud_api', displayName: 'second' });
  });

  after(async () => {
    await app.close();
  });

  it('returns connector capabilities for the configuration page', async () => {
    const response = await app.request('/api/v1/ui/connectors', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.default, 'cloud_api');
    // Capabilities are honest: the Cloud API never offers QR or pairing.
    assert.equal(response.body.data.connectors.cloud_api.qrAuth, false);
    assert.equal(response.body.data.connectors.cloud_api.pairingCode, false);
  });

  it('summarises real instance state in the overview', async () => {
    const response = await app.request('/api/v1/ui/overview', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.connections.total, 2);
    assert.ok(Array.isArray(response.body.data.connections.items));
    assert.equal(response.body.data.service.version.length > 0, true);
    assert.ok(Array.isArray(response.body.data.recentEvents));
    assert.ok(Array.isArray(response.body.data.recentDeliveries));
  });

  it('lists and filters sanitised audit events', async () => {
    const all = await app.request('/api/v1/ui/audit-events?limit=50', { apiKey: owner.plaintext });
    assert.equal(all.status, 200);
    assert.ok(all.body.data.items.length >= 2);
    assert.equal(all.body.pagination.limit, 50);
    // Sanitised: no secret fields are present on an audit event view.
    const event = all.body.data.items[0];
    assert.ok(event.id && event.action && event.result && event.createdAt);

    const connectionOnly = await app.request('/api/v1/ui/audit-events?category=connection&limit=50', {
      apiKey: owner.plaintext,
    });
    assert.equal(connectionOnly.status, 200);
    assert.ok(connectionOnly.body.data.items.every((item) => item.action.startsWith('instance.') || item.action.startsWith('session.')));

    const paged = await app.request('/api/v1/ui/audit-events?limit=1&offset=0', { apiKey: owner.plaintext });
    assert.equal(paged.body.data.items.length, 1);
    assert.equal(paged.body.pagination.hasMore, true);
    assert.equal(paged.body.pagination.nextOffset, 1);
  });

  it('returns an empty delivery list when nothing was sent', async () => {
    const response = await app.request('/api/v1/ui/deliveries', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items, []);
  });

  it('rejects an unknown instance id in the deliveries filter', async () => {
    const response = await app.request('/api/v1/ui/deliveries?instanceId=ins_00000000000000000000000000000000', {
      apiKey: owner.plaintext,
    });
    // The instance does not exist for this tenant -> tenant-isolating 404.
    assert.equal(response.status, 404);
  });

  it('never exposes secret material in the configuration view', async () => {
    const response = await app.request('/api/v1/ui/config', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);

    const raw = response.text;
    // The configured pepper, the encryption key ring and the data directory are
    // all present in the environment, and none of them may reach the browser.
    assert.equal(raw.includes(TEST_PEPPER), false, 'the API key pepper leaked into the config view');
    assert.equal(raw.includes(TEST_KEY_RING.k1), false, 'encryption key material leaked into the config view');
    assert.equal(raw.includes(app.dataDir), false, 'the data directory path leaked into the config view');

    const config = response.body.data;
    assert.equal(config.security.apiKeyPepper, 'configured');
    assert.equal(typeof config.security.encryption.keyCount, 'number');
    assert.equal(config.security.encryption.keys, undefined);
    // Secret-bearing connector values are reported as a status, never a value.
    assert.equal(config.connectors.cloud.accessToken, 'not configured');
    assert.deepEqual(Object.keys(config.storage).sort(), ['dataDirConfigured', 'dataDirIsDefault', 'mode']);
  });
});

describe('owner dashboard with the WhatsApp Web connector disabled', () => {
  let app;
  let owner;

  before(async () => {
    app = await startTestApp({ env: { ENABLE_WHATSAPP_WEB_CONNECTOR: 'false' } });
    owner = await app.issueKey({ tenantId: 'tenant-ui-off', scopes: ['*'], name: 'owner' });
    await app.createInstance(owner.plaintext, { connector: 'cloud_api', displayName: 'cloud only' });
  });

  after(async () => {
    await app.close();
  });

  it('keeps the connectors catalogue readable and reports the web connector as unavailable', async () => {
    const response = await app.request('/api/v1/connectors', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.connectors.cloud_api.enabled, true);
    assert.equal(response.body.data.connectors.web.enabled, false);
    assert.equal(response.body.data.connectors.web.qrAuth, false);
    assert.equal(response.body.data.connectors.web.pairingCode, false);
    assert.ok(response.body.data.connectors.web.limitations.some((line) => line.includes('disabled')));
  });

  it('loads the dashboard overview instead of failing on the disabled connector', async () => {
    const response = await app.request('/api/v1/ui/overview', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.features.webConnectorEnabled, false);
    assert.equal(response.body.data.features.qrAuth, false);
    assert.equal(response.body.data.connections.total, 1);
  });

  it('still advertises QR and pairing support when the connector is enabled', async () => {
    const enabledApp = await startTestApp();
    try {
      const key = await enabledApp.issueKey({ tenantId: 'tenant-ui-on', scopes: ['*'] });
      const response = await enabledApp.request('/api/v1/ui/connectors', { apiKey: key.plaintext });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.connectors.web.enabled, true);
      assert.equal(response.body.data.connectors.web.qrAuth, true);
      assert.equal(response.body.data.connectors.web.pairingCode, true);
    } finally {
      await enabledApp.close();
    }
  });
});
