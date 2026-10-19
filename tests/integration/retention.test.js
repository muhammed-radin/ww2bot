/**
 * Retention: per-instance configuration, manual purge and scope enforcement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';

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

test('retention can be read, updated and purged', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  const described = await app.request(`/api/v1/instances/${instance.id}/retention`, { apiKey: key.plaintext });
  assert.equal(described.status, 200);
  assert.equal(described.body.data.retention.retainMessageContent, true);
  assert.equal(described.body.data.retention.retentionDays, 30);
  assert.equal(described.body.data.retention.storedMessages, 0);

  const updated = await app.request(`/api/v1/instances/${instance.id}/retention`, {
    method: 'PUT',
    apiKey: key.plaintext,
    body: { retentionDays: 5 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.retention.retentionDays, 5);

  await app.container.repositories.messages.upsertMany(instance.id, instance.tenantId, [
    messageRow({ id: 'msg_1', chatId: '919812345678', body: 'to purge', sentAt: '2026-01-01T10:00:00Z' }),
  ]);

  const before = await app.request(`/api/v1/instances/${instance.id}/retention`, { apiKey: key.plaintext });
  assert.equal(before.body.data.retention.storedMessages, 1);

  const purged = await app.request(`/api/v1/instances/${instance.id}/data/purge`, { method: 'POST', apiKey: key.plaintext });
  assert.equal(purged.status, 200);
  assert.equal(purged.body.data.messagesDeleted, 1);

  const after = await app.request(`/api/v1/instances/${instance.id}/retention`, { apiKey: key.plaintext });
  assert.equal(after.body.data.retention.storedMessages, 0);
});

test('retention updates require auth:manage and validate their input', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(admin.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  const reader = await app.issueKey({ scopes: ['instances:read'] });
  const denied = await app.request(`/api/v1/instances/${instance.id}/retention`, {
    method: 'PUT',
    apiKey: reader.plaintext,
    body: { retentionDays: 1 },
  });
  assert.equal(denied.status, 403);

  const invalid = await app.request(`/api/v1/instances/${instance.id}/retention`, {
    method: 'PUT',
    apiKey: admin.plaintext,
    body: { retentionEnabled: true, retentionDays: 0 },
  });
  assert.equal(invalid.status, 400);
});

test('retention changes are recorded in the audit trail', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
  });

  await app.request(`/api/v1/instances/${instance.id}/retention`, {
    method: 'PUT',
    apiKey: key.plaintext,
    body: { retentionDays: 10 },
  });

  const events = await app.request(`/api/v1/instances/${instance.id}/audit-events?action=instance.retention_updated`, {
    apiKey: key.plaintext,
  });
  assert.equal(events.status, 200);
  assert.equal(events.body.data.items.length, 1);
  assert.equal(events.body.data.items[0].instanceId, instance.id);
});
