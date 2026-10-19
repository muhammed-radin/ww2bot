/**
 * Rate limiting: the default per-key/IP budget and the stricter connect budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, withApp } from '../helpers/testApp.js';
import { createFakeCloudClientFactory } from '../helpers/fakeWhatsAppWeb.js';

test('the default budget is enforced with signal headers', async (t) => {
  const app = await startTestApp({ env: { RATE_LIMIT_MAX_REQUESTS: '2' } });
  t.after(() => app.close());
  const key = await app.issueKey({ scopes: ['*'] });

  const first = await app.request('/api/v1/instances', { apiKey: key.plaintext });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('ratelimit-limit'), '2');
  assert.equal(first.headers.get('ratelimit-remaining'), '1');

  const second = await app.request('/api/v1/instances', { apiKey: key.plaintext });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('ratelimit-remaining'), '0');

  const third = await app.request('/api/v1/instances', { apiKey: key.plaintext });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
});

test('the connect budget is counted per key and per instance', async (t) => {
  const app = await withApp(t, {
    env: {
      RATE_LIMIT_MAX_REQUESTS: '1000',
      RATE_LIMIT_CONNECT_MAX_REQUESTS: '1',
      META_ACCESS_TOKEN: 'test-access-token',
      META_PHONE_NUMBER_ID: '106540352242922',
    },
    cloudClientFactory: createFakeCloudClientFactory(),
  });
  const key = await app.issueKey({ scopes: ['*'] });
  const first = await app.createInstance(key.plaintext, { connector: 'cloud_api' });
  const second = await app.createInstance(key.plaintext, { connector: 'cloud_api' });

  const ok = await app.request(`/api/v1/instances/${first.id}/connect/qr`, { method: 'POST', apiKey: key.plaintext });
  assert.equal(ok.status, 200);

  const limited = await app.request(`/api/v1/instances/${first.id}/connect/qr`, { method: 'POST', apiKey: key.plaintext });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');

  // A different instance has its own bucket.
  const otherInstance = await app.request(`/api/v1/instances/${second.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(otherInstance.status, 200);
});
