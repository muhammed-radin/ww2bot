/**
 * Real-time authentication: single-use stream tokens and the SSE event stream.
 * A long-lived API key is accepted only in the header, never in the URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';

/** Open the event stream, read until `stream.ready`, then abort. */
async function readReadyEvent(url, { headers = {}, waitMs = 2000 } = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('stream.ready')) break;
    }
  } finally {
    controller.abort();
  }
  return { status: response.status, contentType: response.headers.get('content-type'), buffer };
}

test('a stream token is issued once, opens the stream, and cannot be reused', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  const issued = await app.request(`/api/v1/instances/${instance.id}/auth/stream-token`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.data.singleUse, true);
  assert.equal(issued.body.data.eventsEndpoint, `/api/v1/instances/${instance.id}/auth/events`);
  assert.equal(typeof issued.body.data.token, 'string');
  // The long-lived key is never involved in the URL.
  assert.equal(JSON.stringify(issued.body).includes(key.plaintext), false);

  const stream = await readReadyEvent(
    `${app.baseUrl}/api/v1/instances/${instance.id}/auth/events?streamToken=${encodeURIComponent(issued.body.data.token)}`,
  );
  assert.equal(stream.status, 200);
  assert.match(stream.contentType, /text\/event-stream/);
  assert.match(stream.buffer, /event: stream\.ready/);
  assert.match(stream.buffer, new RegExp(instance.id));

  const reuse = await app.request(
    `/api/v1/instances/${instance.id}/auth/events?streamToken=${encodeURIComponent(issued.body.data.token)}`,
  );
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error.code, 'INVALID_STREAM_TOKEN');
});

test('the stream accepts an API key header directly', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  const stream = await readReadyEvent(`${app.baseUrl}/api/v1/instances/${instance.id}/auth/events`, {
    headers: { 'x-api-key': key.plaintext },
  });
  assert.equal(stream.status, 200);
  assert.match(stream.buffer, /stream\.ready/);
});

test('without a key or token the stream is refused', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  const { status, body } = await app.request(`/api/v1/instances/${instance.id}/auth/events`);
  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('a stream token is bound to its instance', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const first = await app.createInstance(key.plaintext, { displayName: 'first' });
  const second = await app.createInstance(key.plaintext, { displayName: 'second' });

  const issued = await app.request(`/api/v1/instances/${first.id}/auth/stream-token`, {
    method: 'POST',
    apiKey: key.plaintext,
  });

  const crossed = await app.request(
    `/api/v1/instances/${second.id}/auth/events?streamToken=${encodeURIComponent(issued.body.data.token)}`,
  );
  assert.equal(crossed.status, 401);
});

test('an API key is never accepted from the query string', async (t) => {
  const app = await withApp(t);
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext);

  for (const param of ['apiKey', 'api_key', 'key']) {
    const { status } = await app.request(
      `/api/v1/instances/${instance.id}/chats?${param}=${encodeURIComponent(key.plaintext)}`,
    );
    assert.equal(status, 401, `query parameter "${param}" must not authenticate`);
  }
});

test('issuing a stream token requires connection:read', async (t) => {
  const app = await withApp(t);
  const admin = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(admin.plaintext);

  const dataOnly = await app.issueKey({ scopes: ['data:read'] });
  const denied = await app.request(`/api/v1/instances/${instance.id}/auth/stream-token`, {
    method: 'POST',
    apiKey: dataOnly.plaintext,
  });
  assert.equal(denied.status, 403);
});
