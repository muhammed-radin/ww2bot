import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionState, LIVE_STATES, backoffDelay, mapConnectorStatus } from '../../src/services/connectionState.js';

test('the seven documented states are defined', () => {
  assert.deepEqual(Object.values(ConnectionState), [
    'DISCONNECTED',
    'INITIALIZING',
    'QR_REQUIRED',
    'AUTHENTICATING',
    'CONNECTED',
    'RECONNECTING',
    'ERROR',
  ]);
  assert.ok(LIVE_STATES.includes(ConnectionState.CONNECTED));
  assert.ok(!LIVE_STATES.includes(ConnectionState.ERROR));
  assert.ok(!LIVE_STATES.includes(ConnectionState.DISCONNECTED));
});

test('connector statuses map onto the state machine', () => {
  assert.equal(mapConnectorStatus('ready'), ConnectionState.CONNECTED);
  assert.equal(mapConnectorStatus('authenticated'), ConnectionState.AUTHENTICATING);
  assert.equal(mapConnectorStatus('awaiting_qr'), ConnectionState.QR_REQUIRED);
  assert.equal(mapConnectorStatus('awaiting_pairing_code'), ConnectionState.AUTHENTICATING);
  assert.equal(mapConnectorStatus('initializing'), ConnectionState.INITIALIZING);
  assert.equal(mapConnectorStatus('error'), ConnectionState.ERROR);
  assert.equal(mapConnectorStatus('disconnected'), ConnectionState.DISCONNECTED);
  assert.equal(mapConnectorStatus('destroyed'), ConnectionState.DISCONNECTED);
  assert.equal(mapConnectorStatus('created'), ConnectionState.DISCONNECTED);
  // Unknown statuses default to a non-committal in-progress state.
  assert.equal(mapConnectorStatus('something-new'), ConnectionState.INITIALIZING);
});

test('backoff is exponential, bounded and jittered', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 };
  assert.equal(backoffDelay(1, policy), 100);
  assert.equal(backoffDelay(2, policy), 200);
  assert.equal(backoffDelay(3, policy), 400);
  assert.equal(backoffDelay(4, policy), 800);
  // Clamped at the maximum delay, no unbounded growth.
  assert.equal(backoffDelay(20, policy), 1000);

  const jittered = { baseDelayMs: 1000, maxDelayMs: 60000, jitter: 0.2 };
  for (let attempt = 1; attempt < 20; attempt += 1) {
    const delay = backoffDelay(attempt, jittered);
    assert.ok(delay >= 1, 'delay is always positive');
    assert.ok(delay <= jittered.maxDelayMs * 1.2 + 1, 'delay stays within the jittered ceiling');
  }
});
