/**
 * Secret hygiene: API keys, QR payloads and pairing codes must never leak
 * through responses, the audit trail or logged URLs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { sanitiseUrl } from '../../src/utils/logger.js';
import { redactForAudit } from '../../src/services/audit.service.js';
import { createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

test('API key plaintext never appears in non-creation responses', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'], name: 'admin' });

  const created = await app.request('/api/v1/api-keys', {
    method: 'POST',
    apiKey: admin.plaintext,
    body: { name: 'secondary', scopes: ['instances:read'] },
  });
  const secondary = created.body.data.apiKey;
  const instance = await app.createInstance(admin.plaintext);

  const responses = await Promise.all([
    app.request('/health/live'),
    app.request('/health/ready'),
    app.request('/api/v1/instances', { apiKey: admin.plaintext }),
    app.request(`/api/v1/instances/${instance.id}`, { apiKey: admin.plaintext }),
    app.request(`/api/v1/instances/${instance.id}/status`, { apiKey: admin.plaintext }),
    app.request('/api/v1/api-keys', { apiKey: admin.plaintext }),
    app.request(`/api/v1/instances/ins_${'0'.repeat(32)}`, { apiKey: admin.plaintext }),
    app.request('/api/v1/instances'),
  ]);

  const stored = await app.container.repositories.apiKeys.findByKeyId(admin.record.keyId);
  for (const response of responses) {
    const text = response.text;
    assert.equal(text.includes(admin.plaintext), false, `leaked admin key at ${response.status}`);
    assert.equal(text.includes(secondary), false, 'leaked the secondary key');
    assert.equal(text.includes(stored.keyHash), false, 'leaked a key digest');
  }
});

test('a pairing code never appears in the status payload', async (t) => {
  const app = await withApp(t, { libraryFactory: () => createFakeWhatsAppModule() });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const paired = await app.request(`/api/v1/instances/${instance.id}/connect/pairing-code`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { phoneNumber: '919812345678' },
  });
  assert.equal(paired.body.data.pairingCode, 'ABCD1234');

  const status = await app.request(`/api/v1/instances/${instance.id}/status`, { apiKey: key.plaintext });
  assert.equal(status.text.includes('ABCD1234'), false);

  await app.container.connections.shutdown();
});

test('the audit trail never stores credentials or message content', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  const events = await app.request(`/api/v1/instances/${instance.id}/audit-events`, { apiKey: key.plaintext });
  assert.equal(events.status, 200);
  assert.equal(events.text.includes(key.plaintext), false);

  const redacted = redactForAudit({
    apiKey: 'wak_secret',
    nested: { secret: 'hunter2', body: 'a private message' },
    longText: 'x'.repeat(500),
  });
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.secret, '[REDACTED]');
  assert.equal(redacted.nested.body, '[REDACTED]');
  assert.match(redacted.longText, /\[TRUNCATED\]$/);
});

test('query-string credentials are stripped from logged URLs', () => {
  assert.equal(sanitiseUrl('/health/live'), '/health/live');

  const sanitised = sanitiseUrl('/api/v1/instances/ins_x/auth/events?streamToken=super-secret&limit=10');
  assert.equal(sanitised.includes('super-secret'), false);
  // URLSearchParams percent-encodes the placeholder: %5BREDACTED%5D.
  assert.match(sanitised, /streamToken=(%5BREDACTED%5D|\[REDACTED\])/);
  assert.match(sanitised, /limit=10/);
});

test('error responses expose no stack traces or filesystem paths', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  const errors = await Promise.all([
    app.request('/api/v1/instances'),
    app.request('/api/v1/instances/not-an-id', { apiKey: key.plaintext }),
    app.request('/api/v1/nope', { apiKey: key.plaintext }),
  ]);

  for (const response of errors) {
    assert.equal(response.body.success, false);
    assert.equal(Object.keys(response.body).sort().join(','), 'error,requestId,success');
    assert.equal(typeof response.body.error.code, 'string');
    assert.equal(response.text.includes('at '), false);
    assert.equal(response.text.includes('/home/'), false);
    assert.equal(response.text.includes('node_modules'), false);
  }
});
