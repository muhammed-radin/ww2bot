/**
 * Live gateway smoke test.
 *
 * Runs against a gateway that is already deployed and reachable, identified by:
 *   WA_GATEWAY_LIVE_BASE_URL  e.g. https://gateway.example.com
 *   WA_GATEWAY_LIVE_API_KEY   an API key with at least instances:read
 *
 * It is intentionally read-only: it checks health, connector discovery and
 * instance listing, and never creates, connects or deletes anything.
 *
 *   WA_GATEWAY_LIVE_TESTS=1 \
 *   WA_GATEWAY_LIVE_BASE_URL=https://gateway.example.com \
 *   WA_GATEWAY_LIVE_API_KEY=wak_... \
 *   node --test "tests/live/gateway.live.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveRequest, skipReason } from './helpers/liveEnv.js';

const REQUIRES = ['WA_GATEWAY_LIVE_BASE_URL', 'WA_GATEWAY_LIVE_API_KEY'];

test('the live gateway answers liveness and readiness', { skip: skipReason(REQUIRES) }, async () => {
  const live = await liveRequest('/health/live');
  assert.equal(live.status, 200);
  assert.equal(live.body.success, true);
  assert.equal(live.body.data.status, 'ok');

  const ready = await liveRequest('/health/ready');
  assert.equal(ready.status, 200, `readiness failed: ${ready.text}`);
  assert.equal(ready.body.data.status, 'ready');
});

test('connector discovery reports honest capabilities', { skip: skipReason(REQUIRES) }, async () => {
  const { status, body } = await liveRequest('/api/v1/connectors');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.connectors.cloud_api, 'the official connector must be discoverable');

  const web = body.data.connectors.web;
  // Either the web connector is disabled (enabled:false) or it advertises a
  // written-authorization reference. A missing reference would be a red flag.
  if (web.enabled) {
    assert.ok(web.authorizationReference, 'an enabled web connector must carry its authorization reference');
  } else {
    assert.equal(web.enabled, false);
  }
});

test('an authenticated request lists instances and rejects an unauthenticated one', { skip: skipReason(REQUIRES) }, async () => {
  const authed = await liveRequest('/api/v1/instances');
  assert.equal(authed.status, 200);
  assert.ok(Array.isArray(authed.body.data.items));

  const denied = await liveRequest('/api/v1/instances', { apiKey: '' });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.success, false);
});
