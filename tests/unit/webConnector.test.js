import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { SessionService } from '../../src/services/session.service.js';
import { BrowserManager, InstanceLimitReachedError } from '../../src/connectors/web/browserManager.js';
import { WebConnector } from '../../src/connectors/web/web.connector.js';
import { ConnectionEventBus } from '../../src/events/connectionEvents.js';
import {
  CapabilityNotSupportedError,
  ConflictError,
  ConnectorDisabledError,
  ConnectorError,
  ValidationError,
} from '../../src/utils/errors.js';
import { createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';
import { createTestRepositories } from '../helpers/testStore.js';

async function build({ env = {}, instanceIndex = 0, library, dataDir, browserManager: sharedBrowserManager } = {}) {
  const config = loadConfig({
    ...BASE_TEST_ENV,
    ...env,
  });
  const logger = createLogger(config);
  const { repositories, encryption, store: fileStore, dir } = await createTestRepositories({ logger, dir: dataDir ?? null });
  const sessionService = new SessionService({
    config,
    encryption,
    repository: repositories.sessions,
    logger,
    paths: fileStore.paths,
  });
  const browserManager = sharedBrowserManager ?? new BrowserManager({ config, logger });
  const events = new ConnectionEventBus({ logger });

  const instance = {
    id: `ins_${String(instanceIndex).repeat(32)}`,
    tenantId: 'tenant-a',
    connector: 'web',
    displayName: 'web instance',
    status: 'created',
    metadata: {},
    retentionEnabled: false,
    retentionDays: 0,
  };

  const fakeLibrary = library ?? createFakeWhatsAppModule();
  const connector = new WebConnector({
    instance,
    config,
    logger,
    events,
    sessionService,
    browserManager,
    libraryFactory: () => fakeLibrary,
  });

  return {
    config,
    logger,
    repositories,
    sessionService,
    browserManager,
    events,
    instance,
    connector,
    library: fakeLibrary,
    sessionDir: dir,
  };
}

const cleanup = (directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => {});

test('capabilities are honest and the connector is opt-in', async () => {
  const disabled = await build({ env: { ENABLE_WHATSAPP_WEB_CONNECTOR: 'false', WHATSAPP_WEB_AUTHORIZATION_REFERENCE: '' } });
  const disabledCaps = disabled.connector.getCapabilities();
  assert.equal(disabledCaps.enabled, false);
  assert.equal(disabledCaps.official, false);
  assert.equal(disabledCaps.qrAuth, false);
  await assert.rejects(() => disabled.connector.initialize({ mode: 'qr' }), ConnectorDisabledError);
  await cleanup(disabled.sessionDir);

  const enabled = await build();
  const caps = enabled.connector.getCapabilities();
  assert.equal(caps.enabled, true);
  assert.equal(caps.official, false, 'never presented as an official API');
  assert.equal(caps.qrAuth, true);
  assert.equal(caps.pairingCode, true);
  assert.equal(caps.outboundMessaging, true);
  assert.deepEqual(caps.outboundMessagingTypes, ['text']);
  assert.equal(caps.authorizationReference, 'TEST-AUTHZ-REFERENCE-0001');
  await cleanup(enabled.sessionDir);
});

test('the browser sandbox is never disabled and each instance gets an isolated profile', async () => {
  const first = await build({ instanceIndex: 1 });
  const second = await build({ instanceIndex: 2 });

  await first.connector.requestQrAuth();
  await second.connector.requestQrAuth();

  const firstClient = first.library.__lastClient();
  const secondClient = second.library.__lastClient();

  for (const client of [firstClient, secondClient]) {
    const args = client.options.puppeteer.args;
    assert.ok(!args.some((argument) => argument.includes('--no-sandbox')));
    assert.ok(!args.some((argument) => argument.includes('--disable-setuid-sandbox')));
    assert.ok(args.includes('--disable-dev-shm-usage'));
    assert.equal(client.options.puppeteer.headless, true);
  }

  const firstDir = firstClient.options.authStrategy.options.dataPath;
  const secondDir = secondClient.options.authStrategy.options.dataPath;
  assert.notEqual(firstDir, secondDir);
  assert.equal(firstClient.options.authStrategy.options.clientId, first.instance.id);
  assert.equal(secondClient.options.authStrategy.options.clientId, second.instance.id);

  // The profile directory is private to the process owner.
  const stats = await fs.stat(firstDir);
  assert.equal(stats.mode & 0o777, 0o700);

  await first.connector.destroy();
  await second.connector.destroy();
  await cleanup(first.sessionDir);
  await cleanup(second.sessionDir);
});

test('a QR challenge is delivered as a data URL with a short lifetime', async () => {
  const { connector, events, instance, library, sessionDir } = await build();
  const received = [];
  await events.subscribe(instance.id, (event) => received.push(event));

  const result = await connector.requestQrAuth();
  assert.equal(result.status, 'awaiting_qr');
  assert.match(result.qr.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(new Date(result.qr.expiresAt).getTime() > Date.now());
  assert.ok(library.__lastClient().initialized);

  const qrEvent = received.find((event) => event.type === 'auth.qr');
  assert.ok(qrEvent);
  assert.equal(qrEvent.data.connector, 'web');
  assert.ok(qrEvent.data.qrDataUrl.startsWith('data:image/png;base64,'));
  // The raw QR payload must not be published separately.
  assert.equal(JSON.stringify(qrEvent.data).includes('fakeQrPayload'), false);

  await connector.destroy();
  await cleanup(sessionDir);
});

test('session sync progress and the library state are streamed and exposed in status', async () => {
  const { connector, events, instance, library, sessionDir } = await build();
  const received = [];
  await events.subscribe(instance.id, (event) => received.push(event));

  await connector.requestQrAuth();
  const client = library.__lastClient();

  client.emit('loading_screen', 42, 'WhatsApp');
  client.emit('change_state', 'OPENING');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const loading = received.find((event) => event.type === 'auth.loading');
  assert.ok(loading, 'loading progress is published');
  assert.equal(loading.data.percent, 42);
  assert.equal(loading.data.complete, false);

  const state = received.find((event) => event.type === 'auth.state');
  assert.ok(state, 'the library connection state is published');
  assert.equal(state.data.state, 'OPENING');

  const status = await connector.getStatus();
  assert.equal(status.details.loading.percent, 42);
  assert.equal(status.details.authState, 'OPENING');

  await connector.destroy();
  await cleanup(sessionDir);
});

test('a request for QR while already in QR mode reuses the running session', async () => {
  const { connector, browserManager, sessionDir } = await build();
  await connector.requestQrAuth();
  const firstQr = connector.currentQr();

  const again = await connector.requestQrAuth();
  assert.equal(again.alreadyConnected ?? false, false);
  assert.equal(again.qr.qrDataUrl, firstQr.qrDataUrl);
  assert.equal(browserManager.size, 1, 'no second browser was launched');

  await connector.destroy();
  await cleanup(sessionDir);
});

test('a QR challenge expires and stops being reported', async () => {
  const { connector, sessionDir } = await build();
  await connector.requestQrAuth();
  connector.qrState = { ...connector.qrState, expiresAt: new Date(Date.now() - 1000) };
  assert.equal(connector.currentQr(), null);
  await connector.destroy();
  await cleanup(sessionDir);
});

test('pairing codes are requested through the constructor and never re-requested automatically', async () => {
  const { connector, library, sessionDir } = await build();

  const first = await connector.requestPairingCode('919812345678');
  assert.equal(first.pairingCode, 'ABCD1234');
  assert.equal(first.reused, false);
  assert.equal(connector.status, 'awaiting_pairing_code');

  const client = library.__lastClient();
  assert.deepEqual(client.options.pairWithPhoneNumber, {
    phoneNumber: '919812345678',
    showNotification: false,
    intervalMs: 180000,
  });

  // The same code is returned while it is still valid.
  const second = await connector.requestPairingCode('919812345678');
  assert.equal(second.reused, true);
  assert.equal(second.pairingCode, 'ABCD1234');

  // Forcing a second code while one is pending is refused.
  await assert.rejects(() => connector.requestPairingCode('919812345678', { force: true }), ConflictError);

  // The code is never exposed through the status payload.
  const status = await connector.getStatus();
  assert.equal(JSON.stringify(status).includes('ABCD1234'), false);

  await connector.destroy();
  await cleanup(sessionDir);
});

test('pairing requires a phone number and the connector to be enabled', async () => {
  const { connector, sessionDir } = await build();
  await assert.rejects(() => connector.initialize({ mode: 'pairing_code', phoneNumber: null }), ValidationError);
  await cleanup(sessionDir);
});

test('switching from pairing mode to QR mode rebuilds the client', async () => {
  const { connector, library, sessionDir } = await build();
  await connector.requestPairingCode('919812345678');
  assert.equal(connector.mode, 'pairing_code');

  await connector.requestQrAuth();
  assert.equal(connector.mode, 'qr');
  const client = library.__lastClient();
  assert.equal(client.options.pairWithPhoneNumber, undefined);
  assert.ok(library.__clients.length >= 2);

  await connector.destroy();
  await cleanup(sessionDir);
});

test('data endpoints refuse to run before the instance is connected', async () => {
  const { connector, sessionDir } = await build();
  await assert.rejects(() => connector.listChats({ limit: 10 }), ConflictError);
  await assert.rejects(() => connector.listMessages('919812345678@c.us', { limit: 10 }), ConflictError);
  await assert.rejects(() => connector.listContacts({ limit: 10 }), ConflictError);
  await cleanup(sessionDir);
});

test('chats, messages and contacts are read from the linked session once ready', async () => {
  const { connector, library, sessionDir } = await build();
  await connector.requestQrAuth();
  library.__lastClient().simulateReady();
  assert.equal(connector.status, 'ready');

  const chats = await connector.listChats({ limit: 10 });
  assert.equal(chats.items.length, 3);
  assert.equal(chats.hasMore, false);
  assert.equal(chats.items[0].chatId, '919812345678@c.us');
  assert.equal(chats.items[0].displayName, 'Fixture Chat One');
  assert.equal(chats.items.some((chat) => chat.isGroup), true);

  const limited = await connector.listChats({ limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.hasMore, true);

  const chat = await connector.getChat('919812345678@c.us');
  assert.equal(chat.chatId, '919812345678@c.us');
  assert.ok(chat.limitations.length > 0);

  const messages = await connector.listMessages('919812345678@c.us', { limit: 10 });
  assert.equal(messages.items.length, 2);
  assert.equal(messages.items[0].body, 'Hello from the test fixture');
  assert.equal(messages.items[0].source, 'whatsapp_web');
  assert.equal(messages.hasMore, false);
  assert.equal(messages.nextCursor, null);

  const contacts = await connector.listContacts({ limit: 10 });
  assert.equal(contacts.items.length, 2);
  // Contacts are ordered deterministically by id for keyset pagination.
  assert.equal(contacts.items[0].number, '12025550108');
  assert.equal(contacts.items.some((contact) => contact.number === '919812345678'), true);

  await connector.destroy();
  await cleanup(sessionDir);
});

test('chats and messages stay readable when the library model serialiser throws', async () => {
  // Reproduces current WhatsApp Web builds, where whatsapp-web.js 1.34.7's
  // getChats()/getChatById() reject with an opaque "r" error. The connector
  // must fall back to the page store instead of surfacing a 502.
  const library = createFakeWhatsAppModule({
    brokenChats: true,
    chatMessages: {
      '919812345678@c.us': [
        {
          id: { _serialized: 'false_919812345678@c.us_RAW1', fromMe: false, remote: { _serialized: '919812345678@c.us' } },
          type: 'chat',
          body: 'Raw inbound',
          isMedia: false,
          t: 1700000500,
        },
      ],
    },
  });
  const { connector, sessionDir } = await build({ library });
  await connector.requestQrAuth();
  library.__lastClient().simulateReady();

  const chats = await connector.listChats({ limit: 10 });
  assert.equal(chats.items.length, 3);
  assert.equal(chats.items[0].chatId, '919812345678@c.us');
  assert.equal(chats.items.some((chat) => chat.isGroup), true, 'group chats are detected from the id suffix');

  const chat = await connector.getChat('919812345678@c.us');
  assert.equal(chat.chatId, '919812345678@c.us');

  const messages = await connector.listMessages('919812345678@c.us', { limit: 10 });
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0].body, 'Raw inbound');
  assert.equal(messages.items[0].direction, 'inbound');

  await connector.destroy();
  await cleanup(sessionDir);
});

test('outbound sends preserve a full chat id and only default a bare number', async () => {
  const { connector, library, sessionDir } = await build();
  await connector.requestQrAuth();
  const client = library.__lastClient();
  client.simulateReady();

  const sends = [];
  client.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return { id: { _serialized: `true_${chatId}_OUT` }, fromMe: true, to: chatId, body: text, type: 'chat', timestamp: 1 };
  };

  await connector.sendMessage({ to: '919812345678', text: 'a' });
  await connector.sendMessage({ to: '33247392198739@lid', text: 'b' });
  await connector.sendMessage({ to: '131355503402@c.us', text: 'c' });

  assert.deepEqual(
    sends.map((send) => send.chatId),
    ['919812345678@c.us', '33247392198739@lid', '131355503402@c.us'],
  );

  await connector.destroy();
  await cleanup(sessionDir);
});

test('chat ids supplied by callers are validated', async () => {
  const { connector, library, sessionDir } = await build();
  await connector.requestQrAuth();
  library.__lastClient().simulateReady();

  await assert.rejects(() => connector.getChat('../../etc/passwd'), ValidationError);
  await assert.rejects(() => connector.getChat(''), ValidationError);
  await assert.rejects(() => connector.listMessages('a'.repeat(200)), ValidationError);
  assert.equal(await connector.getChat('99999999999@c.us'), null);

  await connector.destroy();
  await cleanup(sessionDir);
});

test('only one browser per instance may run at a time', async () => {
  const { connector, sessionDir } = await build();
  await connector.requestQrAuth();
  await assert.rejects(() => connector.initialize({ mode: 'qr' }), ConflictError);
  await connector.destroy();
  await cleanup(sessionDir);
});

test('the concurrent browser limit is enforced', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-web-limit-'));
  const config = loadConfig({ ...BASE_TEST_ENV, MAX_BROWSER_INSTANCES: '1' });
  // One process-wide manager, exactly as the container wires it.
  const browserManager = new BrowserManager({ config, logger: createLogger(config) });
  const first = await build({ instanceIndex: 1, dataDir, env: { MAX_BROWSER_INSTANCES: '1' }, browserManager });
  const second = await build({ instanceIndex: 2, dataDir, env: { MAX_BROWSER_INSTANCES: '1' }, browserManager });

  await first.connector.requestQrAuth();
  await assert.rejects(() => second.connector.requestQrAuth(), InstanceLimitReachedError);

  await first.connector.destroy();
  // With the slot free, the second instance can start.
  await second.connector.requestQrAuth();
  await second.connector.destroy();
  await cleanup(dataDir);
});

test('a failed launch releases the browser slot and reports a connector error', async () => {
  const failing = createFakeWhatsAppModule({ behaviour: 'throw' });
  const { connector, browserManager, sessionDir } = await build({ library: failing });

  await assert.rejects(() => connector.requestQrAuth(), ConnectorError);
  assert.equal(connector.status, 'error');
  assert.equal(browserManager.size, 0, 'no browser slot is leaked');
  await cleanup(sessionDir);
});

test('an authentication failure is surfaced as an error event', async () => {
  const failing = createFakeWhatsAppModule({ behaviour: 'fail' });
  const { connector, events, instance, sessionDir } = await build({ library: failing });
  const received = [];
  await events.subscribe(instance.id, (event) => received.push(event));

  await connector.requestQrAuth();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const errorEvent = received.find((event) => event.type === 'connection.error');
  assert.ok(errorEvent);
  assert.equal(JSON.stringify(errorEvent.data).includes('Simulated authentication failure'), true);

  await connector.destroy();
  await cleanup(sessionDir);
});

test('logout unlinks the device and removes the stored profile directory', async () => {
  const { connector, library, sessionService, sessionDir } = await build();
  await connector.requestQrAuth();
  const client = library.__lastClient();
  client.simulateReady();

  const directory = sessionService.instanceDirectory({ id: connector.instance.id, tenantId: 'tenant-a' });
  assert.equal(await sessionService.directoryExists(connector.instance), true);

  const result = await connector.disconnect({ logout: true });
  assert.equal(result.sessionRevoked, true);
  assert.equal(client.loggedOut, true);
  assert.equal(client.destroyed, true);
  assert.equal(await sessionService.directoryExists(connector.instance), false);
  assert.equal(connector.status, 'disconnected');
  assert.ok(directory.includes(connector.instance.id), 'sanity check on path shape');

  await cleanup(sessionDir);
});

test('disconnect without logout keeps the session for reconnection', async () => {
  const { connector, library, sessionService, sessionDir } = await build();
  await connector.requestQrAuth();
  library.__lastClient().simulateReady();

  await connector.disconnect({ logout: false });
  assert.equal(library.__lastClient().destroyed, true);
  // The directory is retained so the instance can reconnect without a new QR.
  assert.equal(await sessionService.directoryExists(connector.instance), true);

  await cleanup(sessionDir);
});

test('an unsupported operation is reported, never silently faked', async () => {
  const { connector, sessionDir } = await build();
  // A connector that implements nothing still answers structurally: the base
  // class reports CAPABILITY_NOT_SUPPORTED instead of returning invented data.
  const { WhatsAppConnector } = await import('../../src/connectors/connector.interface.js');
  class Bare extends WhatsAppConnector {}
  const bare = new Bare({ instance: connector.instance, config: connector.config, logger: connector.logger, events: null });
  await assert.rejects(() => bare.listChats(), CapabilityNotSupportedError);
  await assert.rejects(() => bare.initialize(), CapabilityNotSupportedError);
  // WebConnector genuinely implements the read operations it advertises.
  assert.equal(typeof connector.listChats, 'function');
  assert.equal(connector.getCapabilities().listChats, true);
  await cleanup(sessionDir);
});
