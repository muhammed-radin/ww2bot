/**
 * Live WhatsApp Web (authorised) authentication test.
 *
 * This launches a REAL Chromium via whatsapp-web.js and asks WhatsApp for a QR
 * challenge. It does not scan the QR and never links a device, so it is safe to
 * run but it does require the optional browser dependencies and a machine that
 * can run Chromium.
 *
 * It is gated separately from the other live tests because it starts a browser:
 *
 *   WA_GATEWAY_LIVE_TESTS=1 WA_GATEWAY_LIVE_WEB=1 \
 *   npm run setup:web-connector   # once, installs whatsapp-web.js + puppeteer
 *   node --test "tests/live/webAuth.live.test.js"
 *
 * Enabling the web connector in a real deployment ALSO requires that you hold
 * the written authorization recorded in WHATSAPP_WEB_AUTHORIZATION_REFERENCE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../helpers/testApp.js';
import { liveEnabled } from './helpers/liveEnv.js';

let libraryAvailable = true;
let libraryError = null;
try {
  await import('whatsapp-web.js');
} catch (error) {
  libraryAvailable = false;
  libraryError = error?.message ?? String(error);
}

function webSkipReason() {
  if (!liveEnabled) return 'live tests are opt-in: set WA_GATEWAY_LIVE_TESTS=1';
  if (process.env.WA_GATEWAY_LIVE_WEB !== '1') return 'set WA_GATEWAY_LIVE_WEB=1 to run the browser test';
  if (!libraryAvailable) return `whatsapp-web.js is not installed (${libraryError})`;
  return false;
}

test(
  'a real browser launches and WhatsApp returns a QR challenge',
  { skip: webSkipReason(), timeout: 120000 },
  async (t) => {
    const app = await startTestApp({
      env: process.env.WHATSAPP_WEB_NO_SANDBOX
        ? { WHATSAPP_WEB_NO_SANDBOX: process.env.WHATSAPP_WEB_NO_SANDBOX }
        : undefined,
    });
    t.after(() => app.close());

    const key = await app.issueKey({ scopes: ['*'] });
    const instance = await app.createInstance(key.plaintext, { connector: 'web' });

    const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
      method: 'POST',
      apiKey: key.plaintext,
    });
    assert.equal(connected.status, 200, `connect failed: ${connected.text}`);
    assert.equal(connected.body.data.status, 'awaiting_qr');

    const qr = connected.body.data.qr ?? (await app.waitFor(
      () => app.container.connections.getPendingQr(instance),
      { timeoutMs: 60000, intervalMs: 250 },
    ));
    assert.ok(qr, 'the connector must expose a QR challenge');
    assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
    assert.ok(new Date(qr.expiresAt).getTime() > Date.now(), 'the QR must still be valid');

    // Never log or assert on the raw QR payload; only the rendered image is exposed.
    await app.container.connections.shutdown();
  },
);
