/**
 * Read-only data API: chats, contacts and messages, including the honest
 * CAPABILITY_NOT_SUPPORTED (501) behaviour when a connector cannot serve a
 * request and the retained-message path of the Cloud API connector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

function messageRow({ id, chatId, body, sentAt }) {
  return {
    id,
    instanceId: 'placeholder',
    tenantId: 'placeholder',
    chatId,
    providerMessageId: id,
    direction: 'inbound',
    messageType: 'text',
    body,
    fromId: chatId,
    toId: null,
    sentAt: new Date(sentAt),
    metadata: {},
  };
}

test('the Cloud API connector serves retained inbound messages when retention is on', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  await app.container.repositories.messages.upsertMany(instance.id, instance.tenantId, [
    messageRow({ id: 'msg_1', chatId: '919812345678', body: 'first', sentAt: '2026-01-01T10:00:00Z' }),
    messageRow({ id: 'msg_2', chatId: '919812345678', body: 'second', sentAt: '2026-01-01T11:00:00Z' }),
    messageRow({ id: 'msg_3', chatId: '919800000000', body: 'other chat', sentAt: '2026-01-01T09:00:00Z' }),
  ]);

  const chats = await app.request(`/api/v1/instances/${instance.id}/chats`, { apiKey: key.plaintext });
  assert.equal(chats.status, 200);
  assert.equal(chats.body.data.items.length, 2);
  assert.equal(chats.body.data.items[0].chatId, '919812345678');
  assert.equal(chats.body.data.items[0].messageCount, 2);
  assert.ok(chats.body.data.limitations.length > 0);

  const messages = await app.request(`/api/v1/instances/${instance.id}/chats/919812345678/messages`, {
    apiKey: key.plaintext,
  });
  assert.equal(messages.status, 200);
  assert.equal(messages.body.data.items.length, 2);
  assert.equal(messages.body.data.items[0].body, 'second', 'newest first');

  const limited = await app.request(`/api/v1/instances/${instance.id}/chats/919812345678/messages?limit=1`, {
    apiKey: key.plaintext,
  });
  assert.equal(limited.body.data.items.length, 1);
  assert.equal(limited.body.pagination.hasMore, true);
  assert.ok(limited.body.pagination.nextCursor);
});

test('the Cloud API connector reports 501 when retention is disabled', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'cloud_api' });

  const chats = await app.request(`/api/v1/instances/${instance.id}/chats`, { apiKey: key.plaintext });
  assert.equal(chats.status, 501);
  assert.equal(chats.body.error.code, 'CAPABILITY_NOT_SUPPORTED');

  const contacts = await app.request(`/api/v1/instances/${instance.id}/contacts`, { apiKey: key.plaintext });
  assert.equal(contacts.status, 501);
  assert.equal(contacts.body.error.code, 'CAPABILITY_NOT_SUPPORTED');
});

test('a web instance that is not connected reports 409', async (t) => {
  const app = await withApp(t, { libraryFactory: () => createFakeWhatsAppModule() });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const chats = await app.request(`/api/v1/instances/${instance.id}/chats`, { apiKey: key.plaintext });
  assert.equal(chats.status, 409);
  assert.equal(chats.body.error.code, 'INSTANCE_NOT_CONNECTED');
});

test('a connected web instance serves chats, contacts and messages', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 200);
  library.__lastClient().simulateReady();

  const chats = await app.request(`/api/v1/instances/${instance.id}/chats`, { apiKey: key.plaintext });
  assert.equal(chats.status, 200);
  assert.equal(chats.body.data.items.length, 3);
  assert.equal(chats.body.data.items[0].chatId, '919812345678@c.us');
  assert.equal(chats.body.data.items.some((chat) => chat.isGroup), true);

  const contacts = await app.request(`/api/v1/instances/${instance.id}/contacts`, { apiKey: key.plaintext });
  assert.equal(contacts.status, 200);
  assert.equal(contacts.body.data.items.length, 2);

  const messages = await app.request(`/api/v1/instances/${instance.id}/chats/919812345678@c.us/messages`, {
    apiKey: key.plaintext,
  });
  assert.equal(messages.status, 200);
  assert.equal(messages.body.data.items.length, 2);
  assert.equal(messages.body.data.items[0].source, 'whatsapp_web');

  const missing = await app.request(`/api/v1/instances/${instance.id}/chats/99999999999@c.us`, {
    apiKey: key.plaintext,
  });
  assert.equal(missing.status, 404);

  await app.container.connections.shutdown();
});

test('data routes require the data:read scope', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(admin.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  const reader = await app.issueKey({ scopes: ['instances:read'] });
  const denied = await app.request(`/api/v1/instances/${instance.id}/chats`, { apiKey: reader.plaintext });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body.error.details.missingScopes, ['data:read']);
});

test('a chat id supplied by the caller is validated', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });
  await app.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: key.plaintext });
  library.__lastClient().simulateReady();

  const invalid = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent('../../etc/passwd')}`, {
    apiKey: key.plaintext,
  });
  assert.equal(invalid.status, 400);

  await app.container.connections.shutdown();
});
