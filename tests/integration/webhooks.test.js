/**
 * Cloud API webhook receiver: verification handshake, signature enforcement,
 * idempotent delivery and instance resolution by phone number id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withApp } from '../helpers/testApp.js';

const APP_SECRET = 'app-secret-for-tests';
const VERIFY_TOKEN = 'verify-token-123';
const PHONE_NUMBER_ID = '106540352242922';

const WEBHOOK_ENV = {
  META_ACCESS_TOKEN: 'test-access-token',
  META_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  META_APP_SECRET: APP_SECRET,
  META_VERIFY_TOKEN: VERIFY_TOKEN,
};

function sign(raw) {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
}

function payload({ messageId = 'wamid.TEST1', text = 'hello', phoneNumberId = PHONE_NUMBER_ID } = {}) {
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
              contacts: [{ profile: { name: 'Fixture' }, wa_id: '919812345678' }],
              messages: [{ from: '919812345678', id: messageId, timestamp: '1739321024', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

async function setup(t) {
  const app = await withApp(t, { env: WEBHOOK_ENV });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    retentionEnabled: true,
    retentionDays: 30,
    metadata: { phoneNumberId: PHONE_NUMBER_ID },
  });
  return { app, key, instance };
}

test('the GET verification handshake validates the token and echoes the challenge', async (t) => {
  const { app } = await setup(t);

  const ok = await app.request(
    `/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`,
    { json: false },
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.text, 'abc123');

  const wrong = await app.request('/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc', {
    json: false,
  });
  assert.equal(wrong.status, 403);
});

test('a signed delivery is accepted, stored once and acknowledged', async (t) => {
  const { app, instance } = await setup(t);
  const raw = JSON.stringify(payload({ text: 'retained body' }));

  const accepted = await app.request('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw) },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.accepted, true);
  assert.equal(accepted.body.data.messages, 1);

  const stored = await app.container.repositories.messages.listMessages(instance.id, instance.tenantId, '919812345678', {
    limit: 10,
  });
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].body, 'retained body');

  // A repeated delivery is acknowledged but not re-processed.
  const duplicate = await app.request('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw) },
  });
  assert.equal(duplicate.body.data.messages, 0);
  assert.equal(duplicate.body.data.duplicates, 1);
});

test('an unsigned or wrongly signed delivery is rejected', async (t) => {
  const { app } = await setup(t);
  const raw = JSON.stringify(payload());

  const noSignature = await app.request('/api/v1/webhooks/whatsapp', { method: 'POST', body: raw });
  assert.equal(noSignature.status, 401);

  const badSignature = await app.request('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
  });
  assert.equal(badSignature.status, 401);
  assert.equal(badSignature.body.error.code, 'UNAUTHORIZED');
});

test('a delivery for an unknown phone number id is acknowledged but unmatched', async (t) => {
  const { app } = await setup(t);
  const raw = JSON.stringify(payload({ phoneNumberId: '999999999' }));

  const result = await app.request('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw) },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.unmatched, 1);
  assert.equal(result.body.data.messages, 0);
});
