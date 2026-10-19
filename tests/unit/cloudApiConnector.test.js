import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { MessageStoreService } from '../../src/services/messageStore.service.js';
import { CloudApiConnector } from '../../src/connectors/cloudApi/cloudApi.connector.js';
import { ConnectionEventBus } from '../../src/events/connectionEvents.js';
import { CapabilityNotSupportedError, ConnectorError, ProviderError } from '../../src/utils/errors.js';
import { createFakeCloudClientFactory } from '../helpers/fakeWhatsAppWeb.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';
import { createTestRepositories } from '../helpers/testStore.js';

const PHONE_NUMBER_ID = '106540352242922';

async function build({ retentionEnabled = false, configured = true, cloudFactory } = {}) {
  const config = loadConfig({
    ...BASE_TEST_ENV,
    META_PHONE_NUMBER_ID: configured ? PHONE_NUMBER_ID : '',
    META_ACCESS_TOKEN: configured ? 'test-access-token' : '',
    META_APP_SECRET: 'app-secret',
    META_VERIFY_TOKEN: 'verify-token',
  });
  const logger = createLogger(config);
  const { repositories } = await createTestRepositories({ logger });
  const messageStore = new MessageStoreService({ repository: repositories.messages, logger, config });
  const events = new ConnectionEventBus({ logger });

  const instance = {
    id: `ins_${'b'.repeat(32)}`,
    tenantId: 'tenant-a',
    connector: 'cloud_api',
    displayName: 'cloud',
    status: 'created',
    metadata: { phoneNumberId: PHONE_NUMBER_ID },
    retentionEnabled,
    retentionDays: retentionEnabled ? 7 : 0,
  };

  const connector = new CloudApiConnector({
    instance,
    config,
    logger,
    events,
    messageStore,
    clientFactory: cloudFactory ?? createFakeCloudClientFactory(),
  });

  return { connector, config, repositories, messageStore, instance, events };
}

test('capabilities are accurate and depend on retention', async () => {
  const withoutRetention = (await build({ retentionEnabled: false })).connector.getCapabilities();
  assert.equal(withoutRetention.connector, 'cloud_api');
  assert.equal(withoutRetention.official, true);
  assert.equal(withoutRetention.qrAuth, false);
  assert.equal(withoutRetention.pairingCode, false);
  assert.equal(withoutRetention.historicalMessages, false);
  assert.equal(withoutRetention.listChats, false);
  assert.equal(withoutRetention.listContacts, false);
  assert.equal(withoutRetention.webhooks, true);
  assert.equal(withoutRetention.outboundMessaging, true);

  const withRetention = (await build({ retentionEnabled: true })).connector.getCapabilities();
  assert.equal(withRetention.listChats, true);
  assert.equal(withRetention.listMessages, true);
  assert.equal(withRetention.listContacts, false, 'the Cloud API never exposes a contact list');
  assert.equal(withRetention.historicalMessages, false, 'the Cloud API cannot export history');
});

test('initialize verifies credentials and reports ready', async () => {
  const { connector } = await build();
  const result = await connector.initialize();
  assert.equal(result.status, 'ready');
  assert.equal(connector.status, 'ready');
  assert.equal(result.details.verifiedName, 'Fixture Business');
  assert.equal(result.details.displayPhoneNumber, '15550783881');
  assert.equal(result.details.phoneNumberId, PHONE_NUMBER_ID);
  assert.ok(result.details.lastCheckedAt);
});

test('initialize fails with a connector error when verification fails', async () => {
  const { connector } = await build({ cloudFactory: createFakeCloudClientFactory({ ok: false }) });
  await assert.rejects(() => connector.initialize(), ConnectorError);
  assert.equal(connector.status, 'error');

  const status = await connector.getStatus();
  assert.equal(status.status, 'error');
  assert.ok(status.lastError);
  // No provider internals leak into the status payload.
  assert.equal(JSON.stringify(status).includes('test-access-token'), false);
});

test('initialize refuses to run without credentials', async () => {
  const { connector } = await build({ configured: false });
  await assert.rejects(() => connector.initialize(), /not configured/);
});

test('QR and pairing-code authentication are reported as unsupported', async () => {
  const { connector } = await build();
  await assert.rejects(() => connector.requestQrAuth(), CapabilityNotSupportedError);
  await assert.rejects(() => connector.requestPairingCode('919812345678'), CapabilityNotSupportedError);
  await assert.rejects(() => connector.listContacts(), CapabilityNotSupportedError);
});

test('chats and messages are unavailable until retention is enabled', async () => {
  const { connector } = await build({ retentionEnabled: false });
  await assert.rejects(() => connector.listChats({ limit: 10 }), CapabilityNotSupportedError);
  await assert.rejects(() => connector.listMessages('919812345678', { limit: 10 }), CapabilityNotSupportedError);
  await assert.rejects(() => connector.getChat('919812345678'), CapabilityNotSupportedError);
});

test('with retention enabled, retained webhook messages are readable and honest about limits', async () => {
  const { connector, messageStore, instance } = await build({ retentionEnabled: true });
  await messageStore.storeInbound(instance, [
    {
      chatId: '919812345678',
      providerMessageId: 'wamid.A',
      messageType: 'text',
      body: 'first',
      sentAt: new Date('2026-01-01T10:00:00.000Z'),
    },
    {
      chatId: '919812345678',
      providerMessageId: 'wamid.B',
      messageType: 'text',
      body: 'second',
      sentAt: new Date('2026-01-01T11:00:00.000Z'),
    },
  ]);

  const chats = await connector.listChats({ limit: 10 });
  assert.equal(chats.items.length, 1);
  assert.equal(chats.items[0].messageCount, 2);
  assert.equal(chats.items[0].source, 'retained_inbound_webhook_messages');
  assert.ok(chats.limitations.length > 0);

  const chat = await connector.getChat('919812345678');
  assert.equal(chat.chatId, '919812345678');

  const messages = await connector.listMessages('919812345678', { limit: 10 });
  assert.equal(messages.items.length, 2);
  assert.equal(messages.items[0].id, 'wamid.B', 'newest first');
  assert.equal(messages.items[0].source, 'retained_inbound_webhook_messages');
});

test('the cloud connector has no session to tear down', async () => {
  const { connector } = await build();
  await connector.initialize();
  const result = await connector.disconnect();
  assert.equal(result.status, 'disconnected');
  assert.equal(result.sessionRevoked, false);
  assert.equal(connector.status, 'disconnected');
});

test('provider errors expose a safe subset only', async () => {
  const config = loadConfig({ ...BASE_TEST_ENV, META_PHONE_NUMBER_ID: PHONE_NUMBER_ID, META_ACCESS_TOKEN: 't' });
  const logger = createLogger(config);
  const { CloudApiClient } = await import('../../src/connectors/cloudApi/cloudApi.client.js');
  const client = new CloudApiClient({
    accessToken: 'super-secret-token',
    phoneNumberId: PHONE_NUMBER_ID,
    apiVersion: 'v21.0',
    baseUrl: 'https://graph.example.test',
    logger,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 190, type: 'OAuthException', message: 'Token invalid', fbtrace_id: 'zzz' } }), {
        status: 401,
      }),
  });

  await assert.rejects(
    () => client.getPhoneNumber(),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.details.providerCode, 190);
      assert.equal(JSON.stringify(error.details).includes('super-secret-token'), false);
      assert.equal(JSON.stringify(error.details).includes('fbtrace_id'), false);
      return true;
    },
  );
});

test('an unreachable provider becomes a safe provider error', async () => {
  const config = loadConfig({ ...BASE_TEST_ENV, META_PHONE_NUMBER_ID: PHONE_NUMBER_ID, META_ACCESS_TOKEN: 't' });
  const { CloudApiClient } = await import('../../src/connectors/cloudApi/cloudApi.client.js');
  const client = new CloudApiClient({
    accessToken: 't',
    phoneNumberId: PHONE_NUMBER_ID,
    apiVersion: 'v21.0',
    baseUrl: 'https://graph.example.test',
    logger: createLogger(config),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(() => client.getPhoneNumber(), ProviderError);
});
