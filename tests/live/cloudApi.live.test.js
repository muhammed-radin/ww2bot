/**
 * Live WhatsApp Cloud API credential check.
 *
 * This is a READ-ONLY call to the documented Graph API endpoint that resolves a
 * business phone number. It sends no message and changes no state. Run it when
 * you rotate META_ACCESS_TOKEN to prove the new token is accepted:
 *
 *   WA_GATEWAY_LIVE_TESTS=1 \
 *   META_ACCESS_TOKEN=... META_PHONE_NUMBER_ID=... \
 *   node --test "tests/live/cloudApi.live.test.js"
 *
 * Optional: META_API_VERSION (default v21.0), META_GRAPH_BASE_URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudApiClient } from '../../src/connectors/cloudApi/cloudApi.client.js';
import { skipReason } from './helpers/liveEnv.js';

const REQUIRES = ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID'];

test('the configured Cloud API credentials resolve the business phone number', { skip: skipReason(REQUIRES) }, async () => {
  const client = new CloudApiClient({
    accessToken: process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    apiVersion: process.env.META_API_VERSION ?? 'v21.0',
    baseUrl: process.env.META_GRAPH_BASE_URL ?? 'https://graph.facebook.com',
    timeoutMs: 15000,
  });

  assert.equal(client.configured, true);

  const phoneNumber = await client.getPhoneNumber();
  assert.equal(typeof phoneNumber.id, 'string');
  assert.ok(phoneNumber.id.length > 0);
  // These come straight from Meta; absence would mean the credential works but
  // the number is unusually unconfigured.
  assert.equal(typeof phoneNumber.displayPhoneNumber, 'string');
  assert.equal(typeof phoneNumber.verifiedName, 'string');
});
