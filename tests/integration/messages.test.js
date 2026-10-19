/**
 * Message recording, the instance-wide history API, live message events and
 * automatic replies.
 *
 * The WhatsApp Web library is replaced by the shared fake, so the real
 * connector event wiring, recording, event publication and auto-reply dispatch
 * all run without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

async function connectWeb(app, key, instance) {
  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 200);
  return connected;
}

test('incoming and outgoing web messages are recorded, streamed and readable', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });
  await connectWeb(app, key, instance);
  const client = library.__lastClient();
  client.simulateReady();

  const published = [];
  await app.container.events.subscribe(instance.id, (event) => published.push(event));

  const inbound = client.simulateIncomingMessage({ body: '/hi' });
  await app.waitFor(() => published.find((event) => event.type === 'message.received'));

  const received = published.find((event) => event.type === 'message.received');
  assert.equal(received.data.direction, 'inbound');
  assert.equal(received.data.body, '/hi');
  assert.equal(received.data.chatId, '919812345678@c.us');

  const outbound = client.simulateOutgoingMessage({ body: 'Hi, how are you' });
  await app.waitFor(() => published.find((event) => event.type === 'message.sent'));
  const sent = published.find((event) => event.type === 'message.sent');
  assert.equal(sent.data.direction, 'outbound');
  assert.equal(sent.data.body, 'Hi, how are you');

  // REST history (live buffer, because retention is off for this instance).
  const history = await app.request(`/api/v1/instances/${instance.id}/messages`, { apiKey: key.plaintext });
  assert.equal(history.status, 200);
  assert.equal(history.body.data.items.length, 2);
  assert.equal(history.body.data.items[0].direction, 'outbound', 'newest first');
  assert.equal(history.body.data.items[0].body, 'Hi, how are you');
  assert.ok(history.body.data.limitations.length > 0);

  const filtered = await app.request(`/api/v1/instances/${instance.id}/messages?direction=inbound`, {
    apiKey: key.plaintext,
  });
  assert.equal(filtered.body.data.items.length, 1);
  assert.equal(filtered.body.data.items[0].body, '/hi');

  const single = await app.request(
    `/api/v1/instances/${instance.id}/messages/${encodeURIComponent(inbound.id._serialized)}`,
    { apiKey: key.plaintext },
  );
  assert.equal(single.status, 200);
  assert.equal(single.body.data.message.body, '/hi');

  const missing = await app.request(`/api/v1/instances/${instance.id}/messages/does-not-exist`, {
    apiKey: key.plaintext,
  });
  assert.equal(missing.status, 404);

  await app.container.connections.shutdown();
});

test('an automatic reply is sent when an inbound message matches a rule', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });
  await connectWeb(app, key, instance);
  const client = library.__lastClient();
  client.simulateReady();

  const sends = [];
  client.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return {
      id: { _serialized: `true_${chatId}_AUTO1`, id: 'AUTO1' },
      from: '919800000000@c.us',
      to: chatId,
      fromMe: true,
      type: 'chat',
      body: text,
      hasMedia: false,
      timestamp: Math.floor(Date.now() / 1000),
    };
  };

  const created = await app.request(`/api/v1/instances/${instance.id}/autoreplies`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { name: 'Greeting', match: { type: 'exact', value: '/hi' }, reply: { text: 'Hi, how are you' } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.rule.match.value, '/hi');
  assert.equal(created.body.data.rule.enabled, true);

  client.simulateIncomingMessage({ body: '/hi' });
  await app.waitFor(() => sends.length === 1);
  assert.equal(sends[0].chatId, '919812345678@c.us');
  assert.equal(sends[0].text, 'Hi, how are you');

  // A non-matching message never triggers a send.
  client.simulateIncomingMessage({ body: 'something else' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sends.length, 1);

  const rules = await app.request(`/api/v1/instances/${instance.id}/autoreplies`, { apiKey: key.plaintext });
  assert.equal(rules.status, 200);
  assert.equal(rules.body.data.items.length, 1);
  assert.equal(rules.body.data.items[0].stats.replies, 1);
  assert.equal(rules.body.data.items[0].stats.matches, 1);

  const ruleId = created.body.data.rule.id;
  const partial = await app.request(`/api/v1/instances/${instance.id}/autoreplies/${ruleId}`, {
    method: 'PATCH',
    apiKey: key.plaintext,
    body: { match: { caseSensitive: true } },
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.data.rule.match.value, '/hi', 'a partial match patch keeps the existing value');
  assert.equal(partial.body.data.rule.match.type, 'exact');
  assert.equal(partial.body.data.rule.match.caseSensitive, true);

  const disabled = await app.request(`/api/v1/instances/${instance.id}/autoreplies/${ruleId}`, {
    method: 'PATCH',
    apiKey: key.plaintext,
    body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.rule.enabled, false);

  const removed = await app.request(`/api/v1/instances/${instance.id}/autoreplies/${ruleId}`, {
    method: 'DELETE',
    apiKey: key.plaintext,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.deleted, true);

  await app.container.connections.shutdown();
});

test('an automatic reply preserves a LID-based chat id', async (t) => {
  // Modern WhatsApp uses LID-based ids (...@lid) for direct chats. Rewriting
  // one to a phone-number id addresses the wrong chat, so the exact id must be
  // sent back.
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });
  await connectWeb(app, key, instance);
  const client = library.__lastClient();
  client.simulateReady();

  const sends = [];
  client.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return { id: { _serialized: `true_${chatId}_LID1` }, fromMe: true, to: chatId, body: text, type: 'chat', timestamp: 1 };
  };

  const created = await app.request(`/api/v1/instances/${instance.id}/autoreplies`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { match: { type: 'exact', value: '/hi' }, reply: { text: 'hello' } },
  });
  assert.equal(created.status, 201);

  client.simulateIncomingMessage({ from: '33247392198739@lid', body: '/hi' });
  await app.waitFor(() => sends.length === 1);
  assert.equal(sends[0].chatId, '33247392198739@lid');

  const rules = await app.request(`/api/v1/instances/${instance.id}/autoreplies`, { apiKey: key.plaintext });
  assert.equal(rules.body.data.items[0].stats.replies, 1);

  await app.container.connections.shutdown();
});

test('auto-reply rules are validated and reject an invalid pattern', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'cloud_api' });

  const invalidRegex = await app.request(`/api/v1/instances/${instance.id}/autoreplies`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { match: { type: 'regex', value: '([' }, reply: { text: 'nope' } },
  });
  assert.equal(invalidRegex.status, 400);
  assert.equal(invalidRegex.body.error.code, 'VALIDATION_ERROR');

  const emptyReply = await app.request(`/api/v1/instances/${instance.id}/autoreplies`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { match: { type: 'exact', value: '/hi' }, reply: { text: '   ' } },
  });
  assert.equal(emptyReply.status, 400);

  const unknown = await app.request(`/api/v1/instances/${instance.id}/autoreplies/arr_000000000000000000000000`, {
    apiKey: key.plaintext,
  });
  assert.equal(unknown.status, 404);
});

test('retained messages are served with their direction and content flag', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  await app.container.repositories.messages.upsertMany(instance.id, instance.tenantId, [
    {
      id: 'msg_in',
      instanceId: instance.id,
      tenantId: instance.tenantId,
      chatId: '919812345678',
      providerMessageId: 'wamid.IN',
      direction: 'inbound',
      messageType: 'text',
      body: 'inbound body',
      fromId: '919812345678',
      toId: null,
      sentAt: new Date('2026-01-01T10:00:00Z'),
      metadata: {},
    },
    {
      id: 'msg_out',
      instanceId: instance.id,
      tenantId: instance.tenantId,
      chatId: '919812345678',
      providerMessageId: 'wamid.OUT',
      direction: 'outbound',
      messageType: 'text',
      body: 'outbound body',
      fromId: null,
      toId: '919812345678',
      sentAt: new Date('2026-01-01T11:00:00Z'),
      metadata: {},
    },
  ]);

  const history = await app.request(`/api/v1/instances/${instance.id}/messages`, { apiKey: key.plaintext });
  assert.equal(history.status, 200);
  assert.equal(history.body.data.items.length, 2);
  assert.equal(history.body.data.items[0].direction, 'outbound');
  assert.equal(history.body.data.items[0].contentRetained, true);
  assert.equal(history.body.data.items[0].source, 'retained_outbound_messages');
  assert.equal(history.body.data.items[1].source, 'retained_inbound_webhook_messages');
});

test('capability failures return their curated message, not a generic 500', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'cloud_api' });

  const contacts = await app.request(`/api/v1/instances/${instance.id}/contacts`, { apiKey: key.plaintext });
  assert.equal(contacts.status, 501);
  assert.equal(contacts.body.error.code, 'CAPABILITY_NOT_SUPPORTED');
  assert.notEqual(contacts.body.error.message, 'Internal server error.');
  assert.match(contacts.body.error.message, /contact/i);
});

test('a gateway-sent Cloud API message is recorded as outbound history', async (t) => {
  const app = await withApp(t, {
    env: { META_ACCESS_TOKEN: 'test-token', META_PHONE_NUMBER_ID: '106540352242922' },
    cloudClientFactory: () => ({
      async getPhoneNumber() {
        return { id: '106540352242922', displayPhoneNumber: '15550783881', verifiedName: 'Fixture', qualityRating: 'GREEN' };
      },
      async sendTextMessage() {
        return { providerMessageId: 'wamid.OUTBOUND1', status: 'accepted' };
      },
    }),
  });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
    metadata: { phoneNumberId: '106540352242922' },
  });

  const sent = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: key.plaintext,
    body: { instanceId: instance.id, to: '15551234567', text: 'Your invoice is ready' },
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.status, 'accepted');

  const history = await app.request(`/api/v1/instances/${instance.id}/messages`, { apiKey: key.plaintext });
  assert.equal(history.status, 200);
  assert.equal(history.body.data.items.length, 1);
  assert.equal(history.body.data.items[0].direction, 'outbound');
  assert.equal(history.body.data.items[0].body, 'Your invoice is ready');
  assert.equal(history.body.data.items[0].contentRetained, true);
  assert.equal(history.body.data.items[0].source, 'retained_outbound_messages');
});

test('a failing linked session becomes a curated 502, not a bare 500', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });
  await connectWeb(app, key, instance);
  const client = library.__lastClient();
  client.simulateReady();

  client.getChats = async () => {
    throw new Error('Evaluation failed: page context destroyed');
  };

  const chats = await app.request(`/api/v1/instances/${instance.id}/chats`, { apiKey: key.plaintext });
  assert.equal(chats.status, 502);
  assert.equal(chats.body.error.code, 'CONNECTOR_ERROR');
  assert.notEqual(chats.body.error.message, 'Internal server error.');
  assert.match(chats.body.error.message, /list chats/i);

  await app.container.connections.shutdown();
});

test('the instance-wide message route requires the data:read scope', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(admin.plaintext, { connector: 'cloud_api' });

  const reader = await app.issueKey({ scopes: ['instances:read'] });
  const denied = await app.request(`/api/v1/instances/${instance.id}/messages`, { apiKey: reader.plaintext });
  assert.equal(denied.status, 403);
});
