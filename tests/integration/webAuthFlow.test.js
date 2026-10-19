/**
 * End-to-end web authentication: QR and pairing challenges are delivered over
 * the authenticated SSE stream to the authorised client that asked for them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeWhatsAppModule, FAKE_QR_PAYLOAD } from '../helpers/fakeWhatsAppWeb.js';

/** Start reading an SSE stream in the background; resolves once opened. */
function openStream(url, { headers = {} } = {}) {
  const controller = new AbortController();
  let buffer = '';
  const finished = fetch(url, { headers, signal: controller.signal })
    .then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return response;
    })
    .catch(() => null);

  return {
    get buffer() {
      return buffer;
    },
    async waitFor(needle, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (buffer.includes(needle)) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    },
    async close() {
      controller.abort();
      await finished;
    },
  };
}

test('QR and pairing challenges arrive on the authorised event stream', async (t) => {
  const library = createFakeWhatsAppModule();
  const app = await withApp(t, { libraryFactory: () => library });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });

  const issued = await app.request(`/api/v1/instances/${instance.id}/auth/stream-token`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  const stream = openStream(
    `${app.baseUrl}/api/v1/instances/${instance.id}/auth/events?streamToken=${encodeURIComponent(issued.body.data.token)}`,
  );

  try {
    assert.equal(await stream.waitFor('stream.ready'), true, 'the stream announces itself');
    assert.match(stream.buffer, /"snapshot":\{/, 'a late subscriber receives a status snapshot');

    const qr = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
      method: 'POST',
      apiKey: key.plaintext,
    });
    assert.equal(qr.status, 200);

    assert.equal(await stream.waitFor('event: auth.qr'), true, 'a QR challenge is streamed');
    assert.match(stream.buffer, /data:image\/png;base64,/);
    // The raw pairing/QR credential payload is not handed out in the clear.
    assert.equal(stream.buffer.includes(FAKE_QR_PAYLOAD), false);

    const paired = await app.request(`/api/v1/instances/${instance.id}/connect/pairing-code`, {
      method: 'POST',
      apiKey: key.plaintext,
      body: { phoneNumber: '919812345678' },
    });
    assert.equal(paired.status, 200);

    assert.equal(await stream.waitFor('event: auth.pairing_code'), true, 'a pairing code is streamed');
    assert.match(stream.buffer, /ABCD1234/);

    // Post-authentication sync progress and the library state are streamed too.
    const client = library.__lastClient();
    client.emit('change_state', 'OPENING');
    client.emit('loading_screen', 64, 'WhatsApp');
    assert.equal(await stream.waitFor('event: auth.state'), true, 'the library state is streamed');
    assert.equal(await stream.waitFor('event: auth.loading'), true, 'sync progress is streamed');
    assert.match(stream.buffer, /"percent":64/);
  } finally {
    await stream.close();
    await app.container.connections.shutdown();
  }
});
