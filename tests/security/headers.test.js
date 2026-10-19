/**
 * Transport hardening: security headers, CORS allowlist and body handling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';

const ALLOWED_ORIGIN = 'https://app.example.test';

test('security headers are present and fingerprinting is disabled', async (t) => {
  const app = await withApp(t);
  const { headers } = await app.request('/health/live');

  assert.equal(headers.get('x-powered-by'), null);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.ok(headers.get('content-security-policy'));
  assert.ok(headers.get('strict-transport-security'));
});

test('CORS allows only the configured origins', async (t) => {
  const app = await withApp(t);

  const allowed = await app.request('/health/live', { headers: { origin: ALLOWED_ORIGIN } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

  const denied = await app.request('/health/live', { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  const preflight = await app.request('/api/v1/instances', {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-api-key',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /X-API-Key/i);
});

test('oversized request bodies are rejected with 413', async (t) => {
  const app = await withApp(t, { env: { BODY_LIMIT: '10kb' } });
  const key = await app.issueKey({ scopes: ['*'] });

  const oversized = JSON.stringify({ displayName: 'x'.repeat(50000) });
  const response = await app.request('/api/v1/instances', { method: 'POST', apiKey: key.plaintext, body: oversized });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('malformed JSON is rejected with 400', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });

  const response = await app.request('/api/v1/instances', {
    method: 'POST',
    apiKey: key.plaintext,
    body: '{"displayName":',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});

test('a request with no body where one is optional is accepted', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const response = await app.request('/api/v1/instances', { method: 'POST', apiKey: key.plaintext, body: {} });
  assert.equal(response.status, 201);
});

test('the source-IP allowlist rejects requests from outside it', async (t) => {
  const allowed = await withApp(t, { env: { IP_ALLOWLIST: '127.0.0.1, ::1' } });
  const ok = await allowed.request('/health/live');
  assert.equal(ok.status, 200);

  const blocked = await withApp(t, { env: { IP_ALLOWLIST: '10.0.0.0/8' } });
  const denied = await blocked.request('/health/live');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'IP_NOT_ALLOWED');
});

