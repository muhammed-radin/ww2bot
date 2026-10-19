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
   * Send a text message.
   * @param {{to:string, text:string}} _input
   * @returns {Promise<{status:string, providerMessageId?:string|null}>}
   */
  async sendMessage(_input) {
    return this.#unsupported('sendMessage');
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
    [`GET ${instance}/contacts`]: Boolean(capabilities.listContacts),
    [`POST /api/v1/messages/send`]: Boolean(capabilities.outboundMessaging),
  };
}
