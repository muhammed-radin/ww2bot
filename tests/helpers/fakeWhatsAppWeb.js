/**
 * Fake whatsapp-web.js module for unit and integration tests.
 *
 * It implements the parts of the public API the connector relies on, so tests
 * exercise the real connector code (option building, event wiring, session
 * directory handling) without a browser, a phone, or a real account.
 *
 * Verified against the v1.34.x API surface:
 *   new Client({ authStrategy, puppeteer, pairWithPhoneNumber })
 *   client.initialize() / destroy() / logout()
 *   client.on('qr'|'code'|'authenticated'|'ready'|'auth_failure'|'disconnected')
 *   client.getChats() / getChatById() / getContacts()
 *   client.info
 */
import { EventEmitter } from 'node:events';

export const FAKE_QR_PAYLOAD = '2@9XyZfakeQrPayloadForTests+/=,3@fake';

export function buildFakeChats() {
  const messages = [
    {
      id: { _serialized: 'false_919812345678@c.us_MSG001' },
      from: '919812345678@c.us',
      to: '919800000000@c.us',
      fromMe: false,
      type: 'chat',
      body: 'Hello from the test fixture',
      hasMedia: false,
      caption: null,
      ack: 1,
      timestamp: 1700000300,
    },
    {
      id: { _serialized: 'true_919812345678@c.us_MSG002' },
      from: '919800000000@c.us',
      to: '919812345678@c.us',
      fromMe: true,
      type: 'chat',
      body: 'Reply from the fixture',
      hasMedia: false,
      caption: null,
      ack: 2,
      timestamp: 1700000400,
    },
  ];

  return [
    {
      id: { _serialized: '919812345678@c.us' },
      name: 'Fixture Chat One',
      isGroup: false,
      unreadCount: 2,
      archived: false,
      pinned: true,
      isMuted: false,
      timestamp: 1700000400,
      async fetchMessages({ limit } = {}) {
        return messages.slice(0, limit ?? messages.length);
      },
    },
    {
      id: { _serialized: '12025550108@c.us' },
      name: 'Fixture Chat Two',
      isGroup: false,
      unreadCount: 0,
      archived: false,
      pinned: false,
      isMuted: false,
      timestamp: 1700000000,
      async fetchMessages() {
        return [];
      },
    },
    {
      id: { _serialized: '120363000000000000@g.us' },
      name: 'Fixture Group',
      isGroup: true,
      unreadCount: 5,
      archived: false,
      pinned: false,
      isMuted: true,
      timestamp: 1700000100,
      async fetchMessages() {
        return [messages[0]];
      },
    },
  ];
}

export function buildFakeContacts() {
  return [
    {
      id: { _serialized: '919812345678@c.us' },
      name: 'Fixture Contact',
      pushname: 'Fixture',
      shortName: 'Fixture',
      number: '919812345678',
      isBusiness: false,
      isEnterprise: false,
      isMyContact: true,
    },
    {
      id: { _serialized: '12025550108@c.us' },
      name: null,
      pushname: 'Other',
      shortName: null,
      number: '12025550108',
      isBusiness: true,
      isEnterprise: false,
      isMyContact: false,
    },
  ];
}

/**
 * Minimal stand-in for whatsapp-web.js's `client.pupPage` so the connector's
 * direct page-store fallback can be exercised without a browser. `evaluate`
 * runs the injected function with a fake `window` in scope, exactly as the real
 * page would.
 */
export function createFakePupPage({ chats = buildFakeChats(), chatMessages = {}, sendAction = null } = {}) {
  const byId = new Map(chats.map((chat) => [chat.id._serialized, chat]));
  const pageWindow = {
    require(name) {
      if (name === 'WAWebSendMsgChatAction' && sendAction) return sendAction;
      if (name === 'WAWebCollections') {
        return {
          Chat: {
            get: (wid) => {
              const id = typeof wid === 'string' ? wid : wid?._serialized;
              const chat = byId.get(id);
              if (!chat) return undefined;
              return { ...chat, msgs: { getModelsArray: () => chatMessages[id] ?? [] } };
            },
            getModelsArray: () => chats,
          },
        };
      }
      if (name === 'WAWebWidFactory') {
        return { createWid: (id) => ({ _serialized: id }) };
      }
      if (name === 'WAWebChatLoadMessages') {
        return { loadEarlierMsgs: async () => [] };
      }
      throw new Error(`unexpected require(${name})`);
    },
  };

  return {
    async evaluate(fn, ...args) {
      const previous = globalThis.window;
      globalThis.window = pageWindow;
      try {
        return await fn(...args);
      } finally {
        globalThis.window = previous;
      }
    },
  };
}

export function createFakeWhatsAppModule({
  behaviour = 'auto',
  chats = buildFakeChats(),
  contacts = buildFakeContacts(),
  // Simulate current WhatsApp Web builds, where whatsapp-web.js 1.34.7's
  // getChats()/getChatById() reject with an opaque "r" error. The connector is
  // expected to fall back to a direct page-store read via `pupPage`.
  brokenChats = false,
  // Raw message models returned by the fake page store, keyed by chat id.
  chatMessages = {},
} = {}) {
  const clients = [];

  class MessageMedia {
    constructor(mimetype, data, filename = null, filesize = null) {
      this.mimetype = mimetype;
      this.data = data;
      this.filename = filename;
      this.filesize = filesize;
    }
  }

  class Location {
    constructor(latitude, longitude, options = {}) {
      this.latitude = latitude;
      this.longitude = longitude;
      this.name = options.name;
      this.address = options.address;
      this.url = options.url;
      this.description = options.description;
    }
  }

  class Poll {
    constructor(pollName, pollOptions, options = {}) {
      this.pollName = pollName;
      this.pollOptions = pollOptions.map((name, localId) => ({ name, localId }));
      this.options = { allowMultipleAnswers: options.allowMultipleAnswers === true };
    }
  }

  class Contact {
    constructor(client, data = {}) {
      this.id = data.id ?? { _serialized: '12025550108@c.us' };
      this.name = data.name ?? 'Fixture Contact';
      this.number = data.number ?? '12025550108';
    }
  }

  class FakeClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.info = null;
      this.destroyed = false;
      this.loggedOut = false;
      this.initialized = false;
      this.sentMessages = [];
      this.seen = [];
      this.reactions = [];
      this.mediaById = new Map();
      this.reactionsById = new Map();
      this.pollVotesById = new Map();
      if (brokenChats) this.pupPage = createFakePupPage({ chats, chatMessages });
      clients.push(this);
    }

    async initialize() {
      this.initialized = true;
      const resolvedBehaviour =
        behaviour === 'auto' ? (this.options.pairWithPhoneNumber ? 'pairing' : 'qr') : behaviour;

      if (resolvedBehaviour === 'qr') {
        process.nextTick(() => this.emit('qr', FAKE_QR_PAYLOAD));
      } else if (resolvedBehaviour === 'pairing') {
        process.nextTick(() => this.emit('code', 'ABCD1234'));
      } else if (resolvedBehaviour === 'ready') {
        this.info = { wid: { user: '919800000000' }, platform: 'android', pushname: 'Fixture' };
        process.nextTick(() => {
          this.emit('authenticated');
          this.emit('ready');
        });
      } else if (resolvedBehaviour === 'fail') {
        process.nextTick(() => this.emit('auth_failure', 'Simulated authentication failure'));
      } else if (resolvedBehaviour === 'throw') {
        throw new Error('Simulated launch failure');
      }
    }

    /** Test helper: emit authenticated + ready with link information. */
    simulateReady(info = { wid: { user: '919800000000' }, platform: 'android', pushname: 'Fixture' }) {
      this.info = info;
      this.emit('authenticated');
      this.emit('ready');
    }

    async destroy() {
      this.destroyed = true;
    }

    async logout() {
      this.loggedOut = true;
    }

    async getChats() {
      if (brokenChats) throw Object.assign(new Error('r'), { name: 'r' });
      return chats;
    }

    async getContacts() {
      return contacts;
    }

    async getChatById(chatId) {
      if (brokenChats) throw Object.assign(new Error('r'), { name: 'r' });
      return chats.find((chat) => chat.id._serialized === chatId) ?? null;
    }

    async sendMessage(chatId, content, options = {}) {
      const user = this.info?.wid?.user ?? '919800000000';
      let type = 'chat';
      let body = typeof content === 'string' ? content : null;
      const extra = {};
      if (content instanceof MessageMedia) {
        type = options.sendMediaAsSticker
          ? 'sticker'
          : options.sendAudioAsVoice
            ? 'ptt'
            : options.sendMediaAsDocument
              ? 'document'
              : content.mimetype.startsWith('image/')
                ? 'image'
                : content.mimetype.startsWith('video/')
                  ? 'video'
                  : content.mimetype.startsWith('audio/')
                    ? 'audio'
                    : 'document';
        body = options.caption ?? '';
        extra.mimetype = content.mimetype;
        extra.filename = content.filename;
        extra.size = content.filesize;
        extra.isPtt = Boolean(options.sendAudioAsVoice);
      } else if (content instanceof Location) {
        type = 'location';
        extra.lat = content.latitude;
        extra.lng = content.longitude;
        extra.loc = content.description;
        extra.clientUrl = content.url;
      } else if (content instanceof Poll) {
        type = 'poll_creation';
        body = content.pollName;
        extra.pollName = content.pollName;
        extra.pollOptions = content.pollOptions;
        extra.pollSelectableOptionsCount = content.options.allowMultipleAnswers ? 0 : 1;
      } else if (content instanceof Contact) {
        type = 'vcard';
        body = `BEGIN:VCARD\nFN:${content.name}\nTEL:${content.number}\nEND:VCARD`;
        extra.vcard = body;
      }
      const message = {
        id: { _serialized: `true_${chatId}_OUT${this.sentMessages.length + 1}`, id: `OUT${this.sentMessages.length + 1}` },
        from: `${user}@c.us`,
        to: chatId,
        fromMe: true,
        type,
        body,
        hasMedia: content instanceof MessageMedia,
        timestamp: Math.floor(Date.now() / 1000),
        ...extra,
      };
      this.sentMessages.push({ chatId, content, options, message });
      return message;
    }

    async sendReaction(messageId, reaction) {
      this.reactions.push({ messageId, reaction });
      return true;
    }

    async sendSeen(chatId) {
      this.seen.push(chatId);
      return true;
    }

    async getContactById(contactId) {
      const found = contacts.find((contact) => contact.id._serialized === contactId);
      return new Contact(this, found ?? { id: { _serialized: contactId } });
    }

    async getMessageById(messageId) {
      const media = this.mediaById.get(messageId);
      const reactions = this.reactionsById.get(messageId);
      const pollVotes = this.pollVotesById.get(messageId);
      if (!media && !reactions && !pollVotes) return null;
      return {
        id: { _serialized: messageId },
        hasMedia: Boolean(media),
        async downloadMedia() {
          return media ?? null;
        },
        async getReactions() {
          return reactions;
        },
        async getPollVotes() {
          return pollVotes ?? [];
        },
      };
    }

    async getPollVotes(messageId) {
      return this.pollVotesById.get(messageId) ?? [];
    }

    /** Test helper: emit a realistic inbound message. */
    simulateIncomingMessage(overrides = {}) {
      const message = {
        id: { _serialized: `false_919812345678@c.us_IN${Math.floor(Math.random() * 100000)}`, id: 'IN' },
        from: '919812345678@c.us',
        to: '919800000000@c.us',
        fromMe: false,
        type: 'chat',
        body: 'Hello',
        hasMedia: false,
        timestamp: Math.floor(Date.now() / 1000),
        ...overrides,
      };
      this.emit('message', message);
      return message;
    }

    /** Test helper: emit a realistic outgoing message. */
    simulateOutgoingMessage(overrides = {}) {
      const message = {
        id: { _serialized: `true_919812345678@c.us_OUT${Math.floor(Math.random() * 100000)}`, id: 'OUT' },
        from: '919800000000@c.us',
        to: '919812345678@c.us',
        fromMe: true,
        type: 'chat',
        body: 'Reply',
        hasMedia: false,
        timestamp: Math.floor(Date.now() / 1000),
        ...overrides,
      };
      this.emit('message_create', message);
      return message;
    }
  }

  class LocalAuth {
    constructor(options = {}) {
      this.options = options;
      this.kind = 'local';
    }
  }

  class RemoteAuth {
    constructor(options = {}) {
      this.options = options;
      this.kind = 'remote';
    }
  }

  return {
    Client: FakeClient,
    LocalAuth,
    RemoteAuth,
    MessageMedia,
    Location,
    Poll,
    Contact,
    __clients: clients,
    __lastClient: () => clients[clients.length - 1] ?? null,
  };
}

/** Build a Cloud API client double returning a canned phone-number response. */
export function createFakeCloudClientFactory({ ok = true, response, error, sendError = null, sendResult = null, onSend } = {}) {
  return () =>
    ({
      async getPhoneNumber() {
        if (!ok) throw error ?? new Error('simulated cloud api failure');
        return (
          response ?? {
            id: '106540352242922',
            displayPhoneNumber: '15550783881',
            verifiedName: 'Fixture Business',
            qualityRating: 'GREEN',
            platformType: 'CLOUD_API',
          }
        );
      },
      async sendTextMessage({ to, text }) {
        if (onSend) onSend({ to, text });
        if (sendError) throw sendError;
        return sendResult ?? { providerMessageId: 'wamid.FAKE_SENT', status: 'accepted' };
      },
    });
}
