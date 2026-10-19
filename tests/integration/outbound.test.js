/**
 * Outbound messaging for the RazorBills backend.
 *
 * Verifies the narrow `messages:send` scope, idempotent retries, honest delivery
 * statuses, input validation and the per-recipient rate limit. The Cloud API
 * connector is driven by an injected double, so no network call is made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeCloudClientFactory, createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

const CLOUD_ENV = {
  META_ACCESS_TOKEN: 'test-access-token',
  META_PHONE_NUMBER_ID: '106540352242922',
};

async function cloudApp(t, options = {}) {
  const app = await withApp(t, {
    env: { ...CLOUD_ENV, ...(options.env ?? {}) },
    cloudClientFactory: options.cloudClientFactory ?? createFakeCloudClientFactory(),
  });
  const owner = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(owner.plaintext, {
    connector: 'cloud_api',
    metadata: { phoneNumberId: '106540352242922' },
  });
  await app.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: owner.plaintext });
  return { app, owner, instance };
}

test('a RazorBills key with messages:send can send a text message', async (t) => {
  const { app, instance } = await cloudApp(t);
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const sent = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body: { instanceId: instance.id, to: '+15551234567', text: 'hello from razorbills' },
  });

  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.status, 'accepted');
  assert.equal(sent.body.data.instanceId, instance.id);
  assert.equal(sent.body.data.to, '15551234567');
  assert.equal(sent.body.data.idempotent, false);
  assert.equal(sent.body.data.connector, 'cloud_api');
  // Honesty: "accepted" is never dressed up as delivery.
  assert.match(sent.body.data.note, /Delivery .* not confirmed/i);
});

test('messages:send cannot manage instances or credentials', async (t) => {
  const { app } = await cloudApp(t);
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const create = await app.request('/api/v1/instances', {
    method: 'POST',
    apiKey: service.plaintext,
    body: { connector: 'cloud_api' },
  });
  assert.equal(create.status, 403);
  assert.deepEqual(create.body.error.details.missingScopes, ['auth:manage']);

  const keys = await app.request('/api/v1/api-keys', { apiKey: service.plaintext });
  assert.equal(keys.status, 403);
});

test('sending requires the messages:send scope', async (t) => {
  const { app, instance } = await cloudApp(t);
  const reader = await app.issueKey({ scopes: ['instances:read'] });

  const denied = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: reader.plaintext,
    body: { instanceId: instance.id, to: '15551234567', text: 'nope' },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body.error.details.missingScopes, ['messages:send']);
});

test('a repeated idempotency key does not send twice', async (t) => {
  let sends = 0;
  const cloudClientFactory = createFakeCloudClientFactory({ onSend: () => { sends += 1; } });
  const { app, instance } = await cloudApp(t, { cloudClientFactory });
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const body = {
    instanceId: instance.id,
    to: '15551234567',
    text: 'once only',
    idempotencyKey: 'order-42',
  };

  const first = await app.request('/api/v1/messages/send', { method: 'POST', apiKey: service.plaintext, body });
  const second = await app.request('/api/v1/messages/send', { method: 'POST', apiKey: service.plaintext, body });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.data.idempotent, false);
  assert.equal(second.body.data.idempotent, true);
  assert.equal(second.body.data.providerMessageId, first.body.data.providerMessageId);
  assert.equal(sends, 1, 'the connector was only asked to send once');
});

test('the Idempotency-Key header is honoured', async (t) => {
  let sends = 0;
  const cloudClientFactory = createFakeCloudClientFactory({ onSend: () => { sends += 1; } });
  const { app, instance } = await cloudApp(t, { cloudClientFactory });
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const body = { instanceId: instance.id, to: '15551234567', text: 'header key' };
  const first = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body,
    headers: { 'idempotency-key': 'header-1' },
  });
  const second = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body,
    headers: { 'idempotency-key': 'header-1' },
  });

  assert.equal(first.status, 200);
  assert.equal(second.body.data.idempotent, true);
  assert.equal(sends, 1);
});

test('invalid recipients and content are rejected with 400', async (t) => {
  const { app, instance } = await cloudApp(t);
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const cases = [
    { body: { instanceId: instance.id, to: '0123', text: 'hi' } },
    { body: { instanceId: instance.id, to: '15551234567', text: '   ' } },
    { body: { instanceId: instance.id, to: '15551234567', text: 'hi', type: 'image' } },
    { body: { instanceId: instance.id, to: 'not-a-number', text: 'hi' } },
  ];
  for (const { body } of cases) {
    const response = await app.request('/api/v1/messages/send', { method: 'POST', apiKey: service.plaintext, body });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  }
});

test('the per-recipient rate limit returns 429', async (t) => {
  const { app, instance } = await cloudApp(t, { env: { RATE_LIMIT_RECIPIENT_MAX_REQUESTS: '3' } });
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const body = { instanceId: instance.id, to: '15551234567', text: 'spam' };
  for (let index = 0; index < 3; index += 1) {
    const response = await app.request('/api/v1/messages/send', { method: 'POST', apiKey: service.plaintext, body });
    assert.equal(response.status, 200);
  }
  const limited = await app.request('/api/v1/messages/send', { method: 'POST', apiKey: service.plaintext, body });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
});

test('the WhatsApp Web connector sends text and reports the non-official status', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const owner = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(owner.plaintext, { connector: 'web' });

  await app.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: owner.plaintext });
  library.__lastClient().simulateReady();

  const service = await app.issueKey({ scopes: ['messages:send'] });
  const sent = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body: { instanceId: instance.id, to: '15551234567', text: 'via web' },
  });

  assert.equal(sent.status, 200);
  // The Web connector confirms the library call, not handset delivery.
  assert.equal(sent.body.data.status, 'sent');
  assert.equal(sent.body.data.connector, 'web');
  assert.equal(sent.body.data.note, undefined);
});

test('the WhatsApp Web connector sends to a full chat id unchanged', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const owner = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(owner.plaintext, { connector: 'web' });

  await app.request(`/api/v1/instances/${instance.id}/connect/qr`, { method: 'POST', apiKey: owner.plaintext });
  const client = library.__lastClient();
  client.simulateReady();

  const sends = [];
  client.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return { id: { _serialized: `true_${chatId}_CID1` }, fromMe: true, to: chatId, body: text, type: 'chat', timestamp: 1 };
  };

  const service = await app.issueKey({ scopes: ['messages:send'] });
  const sent = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body: { instanceId: instance.id, to: '33247392198739@lid', text: 'via a lid chat id' },
  });

  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.status, 'sent');
  assert.equal(sent.body.data.to, '33247392198739@lid');
  assert.equal(sends[0].chatId, '33247392198739@lid');
});

test('the Cloud API reduces a full chat id to its phone number', async (t) => {
  const onSend = [];
  const { app, instance } = await cloudApp(t, {
    cloudClientFactory: createFakeCloudClientFactory({ onSend: (args) => onSend.push(args) }),
  });
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const sent = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body: { instanceId: instance.id, to: '15551234567@c.us', text: 'hello' },
  });

  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.to, '15551234567@c.us');
  assert.equal(onSend[0].to, '15551234567', 'the Graph API receives the phone number only');
});

test('a failed send is reported as failed and never as delivered', async (t) => {
  const cloudClientFactory = createFakeCloudClientFactory({ sendError: new Error('provider exploded') });
  const { app, instance } = await cloudApp(t, { cloudClientFactory });
  const service = await app.issueKey({ scopes: ['messages:send'] });

  const failed = await app.request('/api/v1/messages/send', {
    method: 'POST',
    apiKey: service.plaintext,
    body: { instanceId: instance.id, to: '15551234567', text: 'boom' },
  });

  assert.ok(failed.status >= 400);
  assert.equal(JSON.stringify(failed.body).includes('provider exploded'), false, 'no provider internals leak');
});
