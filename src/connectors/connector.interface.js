/**
 * Connector interface.
 *
 * Business logic never imports a WhatsApp library directly: it talks to this
 * interface. Each connector truthfully advertises what it can do through
 * `getCapabilities()`, and any operation it does not genuinely support throws a
 * structured CapabilityNotSupportedError instead of returning invented data.
 */
import { CapabilityNotSupportedError } from '../utils/errors.js';

export const ConnectorCapability = Object.freeze({
  QR_AUTH: 'qrAuth',
  PAIRING_CODE: 'pairingCode',
  LIST_CHATS: 'listChats',
  GET_CHAT: 'getChat',
  LIST_MESSAGES: 'listMessages',
  LIST_CONTACTS: 'listContacts',
  WEBHOOKS: 'webhooks',
  OUTBOUND_MESSAGING: 'outboundMessaging',
  MEDIA_DOWNLOAD: 'mediaDownload',
  SEND_MEDIA: 'sendMedia',
  SEND_LOCATION: 'sendLocation',
  SEND_CONTACT: 'sendContact',
  SEND_POLL: 'sendPoll',
  SEND_REACTION: 'sendReaction',
  MARK_CHAT_SEEN: 'markChatSeen',
  MESSAGE_REACTIONS: 'messageReactions',
  POLL_VOTES: 'pollVotes',
});

export class WhatsAppConnector {
  /** @param {{instance:object, config:object, logger:object, events:object}} options */
  constructor({ instance, config, logger, events }) {
    this.instance = instance;
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.status = 'created';
    this.lastError = null;
  }

  get type() {
    return this.constructor.type ?? 'abstract';
  }

  /** @returns {object} capability descriptor — must be accurate, never aspirational. */
  getCapabilities() {
    throw new Error('getCapabilities() must be implemented by the connector');
  }

  /** @returns {Promise<{status:string, details?:object}>} */
  getStatus() {
    return { status: this.status, details: {} };
  }

  /** @returns {Promise<{status:string, details?:object}>} */
  async initialize() {
    return this.#unsupported('initialize');
  }

  async requestQrAuth() {
    return this.#unsupported('requestQrAuth');
  }

  async requestPairingCode() {
    return this.#unsupported('requestPairingCode');
  }

  async listChats() {
    return this.#unsupported('listChats');
  }

  async getChat() {
    return this.#unsupported('getChat');
  }

  async listMessages() {
    return this.#unsupported('listMessages');
  }

  async listContacts() {
    return this.#unsupported('listContacts');
  }

  /**
   * Send a message of any supported type.
   *
   * The input always names the recipient and the type. Text uses `text`;
   * media uses `media` (`{ mimetype, data, filename, size }`), optional
   * `caption` and flags such as `voice`, `asDocument` and `asSticker`.
   * Other types use `location`, `contactId`/`contact` or `poll`.
   *
   * @param {object} _input
   * @returns {Promise<{status:string, providerMessageId?:string|null, type?:string}>}
   */
  async sendMessage(_input) {
    return this.#unsupported('sendMessage');
  }

  /**
   * Download the media attached to one message.
   * @param {{chatId:string, messageId:string}} _input
   * @returns {Promise<{data:string, mimetype:string, filename?:string|null, size?:number|null}|null>}
   *   Base64 data, or null when the media is no longer available.
   */
  async downloadMedia(_input) {
    return this.#unsupported('downloadMedia');
  }

  /** Add or remove an emoji reaction on a message. */
  async sendReaction(_input) {
    return this.#unsupported('sendReaction');
  }

  /** Mark a conversation as read on the linked device. */
  async markChatSeen(_input) {
    return this.#unsupported('markChatSeen');
  }

  /** Read the reactions currently attached to a message. */
  async getMessageReactions(_input) {
    return this.#unsupported('getMessageReactions');
  }

  /** Read the vote tallies for a poll message. */
  async getPollVotes(_input) {
    return this.#unsupported('getPollVotes');
  }

  /** Release any half-open client before a supervised reconnect. */
  async resetForReconnect() {
    /* connectors without a long-lived client need do nothing */
  }

  async disconnect() {
    return this.#unsupported('disconnect');
  }

  async destroy() {
    this.status = 'destroyed';
  }

  #unsupported(operation) {
    // A connector may not implement getCapabilities() at all; that must never
    // mask the real answer, which is "this operation is not supported".
    let capabilities = null;
    try {
      capabilities = this.getCapabilities();
    } catch {
      capabilities = null;
    }
    throw new CapabilityNotSupportedError(
      `The "${this.type}" connector does not support "${operation}".`,
      { connector: this.type, operation, capabilities },
    );
  }
}

/**
 * Map capabilities to the HTTP endpoints a connector can genuinely serve, so
 * clients can discover limitations from the API instead of from documentation
 * that may drift.
 */
export function describeSupportedEndpoints(capabilities) {
  const instance = '/api/v1/instances/:instanceId';
  return {
    [`GET ${instance}/status`]: true,
    [`POST ${instance}/connect/qr`]: Boolean(capabilities.qrAuth),
    [`POST ${instance}/connect/pairing-code`]: Boolean(capabilities.pairingCode),
    [`GET ${instance}/auth/events`]: true,
    [`GET ${instance}/chats`]: Boolean(capabilities.listChats),
    [`GET ${instance}/chats/:chatId`]: Boolean(capabilities.getChat),
    [`GET ${instance}/chats/:chatId/messages`]: Boolean(capabilities.listMessages),
    [`GET ${instance}/chats/:chatId/messages/:messageId/media`]: Boolean(capabilities.mediaDownload),
    [`GET ${instance}/chats/:chatId/messages/:messageId/reactions`]: Boolean(capabilities.messageReactions),
    [`GET ${instance}/chats/:chatId/messages/:messageId/poll-votes`]: Boolean(capabilities.pollVotes),
    [`GET ${instance}/contacts`]: Boolean(capabilities.listContacts),
    [`POST ${instance}/chats/:chatId/messages`]: Boolean(capabilities.outboundMessaging),
    [`POST ${instance}/chats/:chatId/messages/media`]: Boolean(capabilities.sendMedia),
    [`POST ${instance}/chats/:chatId/messages/poll`]: Boolean(capabilities.sendPoll),
    [`POST ${instance}/chats/:chatId/messages/location`]: Boolean(capabilities.sendLocation),
    [`POST ${instance}/chats/:chatId/messages/contact`]: Boolean(capabilities.sendContact),
    [`POST ${instance}/chats/:chatId/messages/:messageId/reaction`]: Boolean(capabilities.sendReaction),
    [`POST ${instance}/chats/:chatId/seen`]: Boolean(capabilities.markChatSeen),
    [`POST /api/v1/messages/send`]: Boolean(capabilities.outboundMessaging),
  };
}
