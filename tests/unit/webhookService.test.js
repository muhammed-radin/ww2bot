import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { MessageStoreService } from '../../src/services/messageStore.service.js';
import { WebhookService, normaliseInboundMessage } from '../../src/services/webhook.service.js';
import { ConnectionEventBus } from '../../src/events/connectionEvents.js';
import { AuditService } from '../../src/services/audit.service.js';
import { ServiceUnavailableError } from '../../src/utils/errors.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';
import { createTestRepositories } from '../helpers/testStore.js';

const PHONE_NUMBER_ID = '106540352242922';
const APP_SECRET = 'app-secret-for-tests';

async function build({ withAppSecret = true, verifyToken = true, retentionEnabled = true } = {}) {
  const config = loadConfig({
    ...BASE_TEST_ENV,
    META_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    META_ACCESS_TOKEN: 'test-access-token',
    META_APP_SECRET: withAppSecret ? APP_SECRET : '',
    META_VERIFY_TOKEN: verifyToken ? 'verify-token' : '',
    RETAIN_MESSAGE_CONTENT: retentionEnabled ? 'true' : 'false',
  });
  const logger = createLogger(config);
  const { repositories } = await createTestRepositories({ logger });
  const messageStore = new MessageStoreService({ repository: repositories.messages, logger, config });
  const events = new ConnectionEventBus({ logger });
  const audit = new AuditService({ repository: repositories.audit, logger });
  const webhooks = new WebhookService({ config, logger, repositories, messageStore, events, audit });

  const instance = await repositories.instances.create({
    id: `ins_${'a'.repeat(32)}`,
    tenantId: 'tenant-a',
    connector: 'cloud_api',
    displayName: 'cloud instance',
    status: 'ready',
    metadata: { phoneNumberId: PHONE_NUMBER_ID },
    retentionEnabled,
    retentionDays: retentionEnabled ? 7 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastConnectedAt: null,
  });

  return { config, webhooks, messageStore, repositories, instance, events };
}

function buildPayload({ messageId = 'wamid.TEST1', text = 'hello there', phoneNumberId = PHONE_NUMBER_ID, from = '919812345678', type = 'text' } = {}) {
  const message = { from, id: messageId, timestamp: '1739321024', type };
  if (type === 'text') message.text = { body: text };
  if (type === 'image') message.image = { id: 'media-1', mime_type: 'image/jpeg', caption: 'a caption' };
  if (type === 'location') message.location = { latitude: 1.5, longitude: 2.5 };
  if (type === 'interactive') {
    message.interactive = { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes please' } };
  }
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Fixture' }, wa_id: from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function sign(body) {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

test('a valid signature verifies and an invalid one does not', async () => {
  const { webhooks } = await build();
  const raw = Buffer.from(JSON.stringify(buildPayload()));

  assert.equal(webhooks.verifySignature(raw, sign(raw)), true);
  assert.equal(webhooks.verifySignature(raw, `sha256=${'0'.repeat(64)}`), false);
  assert.equal(webhooks.verifySignature(raw, 'sha256=short'), false);
  assert.equal(webhooks.verifySignature(raw, 'nope'), false);
  assert.equal(webhooks.verifySignature(raw, undefined), false);
  // A different body produces a different signature.
  assert.equal(webhooks.verifySignature(Buffer.from('{}'), sign(raw)), false);
});

test('signature verification fails closed when the app secret is missing', async () => {
  // With no verify token either, the webhook surface is simply unconfigured,
  // and signature verification must refuse rather than accept anything.
  const { webhooks } = await build({ withAppSecret: false, verifyToken: false });
  const raw = Buffer.from('{}');
  assert.throws(() => webhooks.verifySignature(raw, 'sha256=abc'), ServiceUnavailableError);
});

test('an inbound message is stored and its body is not put on the event bus', async () => {
  const { webhooks, repositories, instance, events } = await build();
  const published = [];
  await events.subscribe(instance.id, (event) => published.push(event));

  const summary = await webhooks.handleCloudPayload({ payload: buildPayload({ text: 'sensitive body' }) });
  assert.equal(summary.messages, 1);
  assert.equal(summary.duplicates, 0);

  const chats = await repositories.messages.listChats(instance.id, instance.tenantId, { limit: 10 });
  assert.equal(chats.items.length, 1);
  assert.equal(chats.items[0].chatId, '919812345678');

  const stored = await repositories.messages.listMessages(instance.id, instance.tenantId, '919812345678', { limit: 10 });
  assert.equal(stored.items[0].body, 'sensitive body');

  const messageEvent = published.find((event) => event.type === 'message.received');
  assert.ok(messageEvent);
  assert.equal(JSON.stringify(messageEvent.data).includes('sensitive body'), false);
});

test('duplicate deliveries are ignored (idempotent webhook handling)', async () => {
  const { webhooks, repositories, instance } = await build();
  const payload = buildPayload({ messageId: 'wamid.DUPLICATE' });

  const first = await webhooks.handleCloudPayload({ payload });
  const second = await webhooks.handleCloudPayload({ payload });

  assert.equal(first.messages, 1);
  assert.equal(second.messages, 0);
  assert.equal(second.duplicates, 1);
  const stored = await repositories.messages.listMessages(instance.id, instance.tenantId, '919812345678', { limit: 10 });
  assert.equal(stored.items.length, 1);
});

test('message statuses are de-duplicated per status value', async () => {
  const { webhooks } = await build();
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              statuses: [{ id: 'wamid.STATUS1', status: 'delivered', timestamp: '1' }],
            },
          },
        ],
      },
    ],
  };

  const first = await webhooks.handleCloudPayload({ payload });
  const second = await webhooks.handleCloudPayload({ payload });
  assert.equal(first.statuses, 1);
  assert.equal(second.statuses, 0);
  assert.equal(second.duplicates, 1);
});

test('content is not persisted when retention is disabled', async () => {
  const { webhooks, repositories, instance } = await build({ retentionEnabled: false });
  const summary = await webhooks.handleCloudPayload({ payload: buildPayload() });
  assert.equal(summary.messages, 1);
  const messages = await repositories.messages.countByInstance(instance.id, instance.tenantId);
  assert.equal(messages, 0);
});

test('a webhook for an unknown phone number id is not attributed to any instance', async () => {
  const { webhooks, repositories } = await build();
  const summary = await webhooks.handleCloudPayload({ payload: buildPayload({ phoneNumberId: '999999' }) });
  assert.equal(summary.unmatched, 1);
  assert.equal(summary.messages, 0);
  const events = await repositories.audit.list({ tenantId: null, limit: 10 });
  assert.ok(events.some((event) => event.action === 'webhook.received' && event.result === 'failure'));
});

test('malformed payloads are acknowledged without processing', async () => {
  const { webhooks } = await build();
  assert.deepEqual(await webhooks.handleCloudPayload({ payload: null }), {
    messages: 0,
    statuses: 0,
    duplicates: 0,
    unmatched: 0,
  });
  assert.equal((await webhooks.handleCloudPayload({ payload: { object: 'page' } })).messages, 0);
});

test('the verification handshake validates mode, token and challenge', async () => {
  const { webhooks } = await build();

  assert.deepEqual(webhooks.verifyChallenge({ mode: 'subscribe', token: 'verify-token', challenge: 'abc123' }), {
    ok: true,
    challenge: 'abc123',
  });
  assert.equal(webhooks.verifyChallenge({ mode: 'unsubscribe', token: 'verify-token', challenge: 'abc' }).ok, false);
  assert.equal(webhooks.verifyChallenge({ mode: 'subscribe', token: 'wrong', challenge: 'abc' }).ok, false);
  assert.equal(webhooks.verifyChallenge({ mode: 'subscribe', token: 'verify-token', challenge: 'has space' }).ok, false);
  assert.equal(webhooks.verifyChallenge({ mode: 'subscribe', token: 'verify-token' }).ok, false);
});

test('inbound message normalisation extracts a safe textual representation', () => {
  const text = normaliseInboundMessage({ from: '919812345678', id: 'wamid.1', timestamp: '1739321024', type: 'text', text: { body: 'hi' } });
  assert.equal(text.messageType, 'text');
  assert.equal(text.body, 'hi');
  assert.equal(text.chatId, '919812345678');
  assert.equal(text.direction, 'inbound');
  assert.deepEqual(text.metadata, { contextMessageId: null, forwarded: false });

  const image = normaliseInboundMessage({
    id: 'x',
    type: 'image',
    image: { caption: 'cap', mime_type: 'image/jpeg', filename: 'photo.jpg' },
  });
  assert.equal(image.body, 'cap');
  assert.equal(image.metadata.hasMedia, true);
  assert.equal(image.metadata.caption, 'cap');
  assert.deepEqual(image.metadata.media, { mimetype: 'image/jpeg', filename: 'photo.jpg', isPtt: false });

  const location = normaliseInboundMessage({
    id: 'x',
    type: 'location',
    location: { latitude: 12.9716, longitude: 77.5946, name: 'Cubbon Park', address: 'Bengaluru' },
  });
  assert.equal(location.body, null);
  assert.deepEqual(location.metadata.location, {
    latitude: 12.9716,
    longitude: 77.5946,
    name: 'Cubbon Park',
    address: 'Bengaluru',
    url: null,
  });

  const contacts = normaliseInboundMessage({
    id: 'x',
    type: 'contacts',
    contacts: [
      {
        name: { formatted_name: 'Ada Lovelace' },
        phones: [{ phone: '+44 20 7946 0958' }],
        org: { company: 'Analytical' },
      },
    ],
  });
  assert.deepEqual(contacts.metadata.contacts, [
    { name: 'Ada Lovelace', organization: 'Analytical', phones: ['+442079460958'] },
  ]);

  assert.equal(
    normaliseInboundMessage({ id: 'x', type: 'interactive', interactive: { button_reply: { title: 'Yes' } } }).body,
    'Yes',
  );
  assert.equal(normaliseInboundMessage({ id: 'x', type: 'sticker' }).body, null);
  assert.equal(normaliseInboundMessage({ id: 'x', type: 'unknown_type' }).messageType, 'unknown_type');

  // A missing or invalid timestamp still yields a usable Date.
  assert.ok(normaliseInboundMessage({ id: 'x', type: 'text' }).sentAt instanceof Date);
});
