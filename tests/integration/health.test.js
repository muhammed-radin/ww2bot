/**
 * Health endpoints and the uniform error envelope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';

test('/health/live reports liveness without leaking configuration', async (t) => {
  const app = await withApp(t);
  const { status, headers, body } = await app.request('/health/live');

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'ok');
  assert.equal(typeof body.data.uptimeSeconds, 'number');
  assert.ok(headers.get('x-request-id'), 'a request id is always returned');

  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes(app.config.security.apiKeyPepper), false);
  assert.equal(serialised.includes('API_KEY_PEPPER'), false);
});

test('/health/ready reports dependency checks', async (t) => {
  const app = await withApp(t);
  const { status, body } = await app.request('/health/ready');

  assert.equal(status, 200);
  assert.equal(body.data.status, 'ready');
  assert.equal(body.data.checks.storage.mode, 'filesystem');
  assert.equal(body.data.checks.storage.ok, true);
  assert.equal(body.data.checks.realtime.ok, true);
});

test('a client-supplied request id is echoed and returned in errors', async (t) => {
  const app = await withApp(t);
  const ok = await app.request('/health/live', { headers: { 'x-request-id': 'req_client_supplied_1' } });
  assert.equal(ok.headers.get('x-request-id'), 'req_client_supplied_1');

  const missing = await app.request('/api/v1/instances', { headers: { 'x-request-id': 'req_client_supplied_2' } });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.requestId, 'req_client_supplied_2');
});

test('an invalid request id is replaced rather than trusted', async (t) => {
  const app = await withApp(t);
  const { headers } = await app.request('/health/live', { headers: { 'x-request-id': 'bad id with spaces' } });
  assert.match(headers.get('x-request-id'), /^req_[a-f0-9]{32}$/);
});

test('unknown endpoints return the shared 404 envelope', async (t) => {
  const app = await withApp(t);
  const { status, body } = await app.request('/api/v1/does-not-exist');

  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.requestId);
});
