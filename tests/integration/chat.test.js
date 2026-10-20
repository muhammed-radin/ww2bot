/**
 * Per-chat actions used by the owner conversation page: rich sends, media
 * upload/download, reactions, poll tallies and marking a chat as read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from '../helpers/testApp.js';
import { createFakeWhatsAppModule } from '../helpers/fakeWhatsAppWeb.js';

async function webApp(t, options = {}) {
  const library = createFakeWhatsAppModule(options.fake ?? {});
  const app = await withApp(t, { libraryFactory: () => library, ...options.app });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, { connector: 'web' });
  const connected = await app.request(`/api/v1/instances/${instance.id}/connect/qr`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(connected.status, 200);
  const client = library.__lastClient();
  client.simulateReady();
  return { app, key, instance, client, library };
}

const CHAT = '919812345678@c.us';
const header = (value) => Buffer.from(value, 'utf8').toString('base64url');

test('text, poll, location, contact, reaction and seen actions reach the linked client', async (t) => {
  const { app, key, instance, client } = await webApp(t);

  const text = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { text: 'hello from the chat page' },
  });
  assert.equal(text.status, 200);
  assert.equal(text.body.data.status, 'sent');
  assert.equal(text.body.data.type, 'text');
  assert.equal(client.sentMessages[0].content, 'hello from the chat page');

  const poll = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/poll`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { question: 'Lunch?', options: ['Pizza', 'Sushi'], allowMultipleAnswers: false },
  });
  assert.equal(poll.status, 200);
  assert.equal(client.sentMessages[1].message.type, 'poll_creation');
  assert.equal(client.sentMessages[1].content.pollName, 'Lunch?');

  const location = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/location`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { latitude: 12.9716, longitude: 77.5946, name: 'Bengaluru' },
  });
  assert.equal(location.status, 200);
  assert.equal(client.sentMessages[2].message.type, 'location');
  assert.equal(client.sentMessages[2].content.latitude, 12.9716);

  const contact = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/contact`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { contactId: '12025550108@c.us' },
  });
  assert.equal(contact.status, 200);
  assert.equal(client.sentMessages[3].message.type, 'vcard');

  const reaction = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent('false_919812345678@c.us_MSG001')}/reaction`,
    { method: 'POST', apiKey: key.plaintext, body: { reaction: '👍' } },
  );
  assert.equal(reaction.status, 200);
  assert.deepEqual(client.reactions[0], {
    messageId: 'false_919812345678@c.us_MSG001',
    reaction: '👍',
  });

  const seen = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/seen`, {
    method: 'POST',
    apiKey: key.plaintext,
  });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.data.status, 'seen');
  assert.deepEqual(client.seen, [CHAT]);

  await app.container.connections.shutdown();
});

test('media uploads preserve the type, caption, filename and voice flag', async (t) => {
  const { app, key, instance, client } = await webApp(t);
  const bytes = Buffer.from('fake image bytes');

  const image = await app.request(`/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/media`, {
    method: 'POST',
    apiKey: key.plaintext,
    rawBody: bytes,
    headers: {
      'x-media-mimetype': 'image/png',
      'x-media-filename': header('holiday.png'),
      'x-media-caption': header('From the trip'),
    },
  });
  assert.equal(image.status, 200);
  assert.equal(image.body.data.type, 'image');
  const sentImage = client.sentMessages[0];
  assert.equal(sentImage.message.type, 'image');
  assert.equal(sentImage.content.mimetype, 'image/png');
  assert.equal(sentImage.content.filename, 'holiday.png');
  assert.equal(sentImage.options.caption, 'From the trip');

  const voice = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/media?voice=1`,
    {
      method: 'POST',
      apiKey: key.plaintext,
      rawBody: Buffer.from('fake audio bytes'),
      headers: { 'x-media-mimetype': 'audio/webm' },
    },
  );
  assert.equal(voice.status, 200);
  assert.equal(voice.body.data.type, 'voice');
  const sentVoice = client.sentMessages[1];
  assert.equal(sentVoice.message.type, 'ptt');
  assert.equal(sentVoice.options.sendAudioAsVoice, true);

  const doc = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/media?document=1`,
    {
      method: 'POST',
      apiKey: key.plaintext,
      rawBody: Buffer.from('%PDF-1.4'),
      headers: { 'x-media-mimetype': 'application/pdf', 'x-media-filename': header('invoice.pdf') },
    },
  );
  assert.equal(doc.status, 200);
  assert.equal(doc.body.data.type, 'document');
  assert.equal(client.sentMessages[2].message.type, 'document');
  assert.equal(client.sentMessages[2].options.sendMediaAsDocument, true);

  await app.container.connections.shutdown();
});

test('media download returns bytes from the linked client', async (t) => {
  const { app, key, instance, client } = await webApp(t);
  const messageId = 'false_919812345678@c.us_MEDIA1';
  client.mediaById.set(messageId, {
    data: Buffer.from('image-bytes').toString('base64'),
    mimetype: 'image/jpeg',
    filename: 'photo.jpg',
    filesize: 11,
  });

  const downloaded = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent(messageId)}/media`,
    { apiKey: key.plaintext },
  );
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/jpeg');
  assert.match(downloaded.headers.get('content-disposition'), /photo\.jpg/);
  assert.equal(downloaded.text, 'image-bytes');

  const missing = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent('false_x_MISSING')}/media`,
    { apiKey: key.plaintext },
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'MEDIA_UNAVAILABLE');

  await app.container.connections.shutdown();
});

test('reactions and poll tallies are read from the linked client', async (t) => {
  const { app, key, instance, client } = await webApp(t);
  const messageId = 'false_919812345678@c.us_POLL1';
  client.reactionsById.set(messageId, [
    { id: '👍', senders: [{ senderId: CHAT, timestamp: 1 }] },
  ]);
  client.pollVotesById.set(messageId, [
    { voter: CHAT, selectedOptions: [{ name: 'Pizza', localId: 0 }], interractedAtTs: 1 },
  ]);

  const reactions = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent(messageId)}/reactions`,
    { apiKey: key.plaintext },
  );
  assert.equal(reactions.status, 200);
  assert.equal(reactions.body.data.reactions[0].emoji, '👍');

  const votes = await app.request(
    `/api/v1/instances/${instance.id}/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent(messageId)}/poll-votes`,
    { apiKey: key.plaintext },
  );
  assert.equal(votes.status, 200);
  assert.equal(votes.body.data.votes[0].voter, CHAT);

  await app.container.connections.shutdown();
});

test('poll creation is reported as unsupported by the Cloud API', async (t) => {
  const app = await withApp(t, {
    env: { META_ACCESS_TOKEN: 'token', META_PHONE_NUMBER_ID: '106540352242922' },
    cloudClientFactory: () => ({
      async getPhoneNumber() {
        return { id: '106540352242922', displayPhoneNumber: '15550783881', verifiedName: 'Fixture' };
      },
      async sendTextMessage() {
        return { providerMessageId: 'wamid.1', status: 'accepted' };
      },
    }),
  });
  const key = await app.issueKey({ scopes: ['*'] });
  const instance = await app.createInstance(key.plaintext, {
    connector: 'cloud_api',
    metadata: { phoneNumberId: '106540352242922' },
  });

  const poll = await app.request(`/api/v1/instances/${instance.id}/chats/15551234567/messages/poll`, {
    method: 'POST',
    apiKey: key.plaintext,
    body: { question: 'Lunch?', options: ['Pizza', 'Sushi'] },
  });
  assert.equal(poll.status, 501);
  assert.equal(poll.body.error.code, 'CAPABILITY_NOT_SUPPORTED');
});
