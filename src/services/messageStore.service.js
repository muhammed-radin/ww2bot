/**
 * Message store service.
 *
 * The single place that decides whether message content may be written to disk,
 * and the read side used by connectors that can only offer retained webhook
 * messages (the official Cloud API connector). Retention is opt-in per instance.
 */
import { NotFoundError } from '../utils/errors.js';
import { randomHex } from '../utils/ids.js';

export class MessageStoreService {
  constructor({ repository, logger, config }) {
    this.repository = repository;
    this.logger = logger;
    this.config = config;
  }

  /** @returns {boolean} whether content may be persisted for this instance. */
  retentionEnabled(instance) {
    return Boolean(instance.retentionEnabled) && instance.retentionDays > 0;
  }

  /**
   * Persist inbound messages. Silently no-ops when retention is disabled — the
   * message body is then never written anywhere.
   */
  async storeInbound(instance, messages) {
    return this.storeMessages(instance, messages, { direction: 'inbound' });
  }

  /** Persist outbound messages the gateway itself handed to WhatsApp. */
  async storeOutbound(instance, messages) {
    return this.storeMessages(instance, messages, { direction: 'outbound' });
  }

  /**
   * Persist messages. Silently no-ops when retention is disabled — the message
   * body is then never written anywhere.
   * @param {object} instance
   * @param {object[]} messages
   * @param {{direction?: 'inbound'|'outbound'}} [defaults]
   */
  async storeMessages(instance, messages, { direction = 'inbound' } = {}) {
    if (!this.retentionEnabled(instance) || messages.length === 0) {
      return { stored: 0, retentionEnabled: false };
    }
    const now = new Date();
    const rows = messages.map((message) => ({
      id: `msg_${randomHex(12)}`,
      instanceId: instance.id,
      tenantId: instance.tenantId,
      chatId: message.chatId,
      providerMessageId: message.providerMessageId,
      direction: message.direction ?? direction,
      messageType: message.messageType ?? 'unknown',
      body: message.body ?? null,
      fromId: message.fromId ?? null,
      toId: message.toId ?? null,
      sentAt: message.sentAt ?? now,
      metadata: message.metadata ?? {},
      createdAt: now,
    }));
    const stored = await this.repository.upsertMany(instance.id, instance.tenantId, rows);
    return { stored, retentionEnabled: true };
  }

  /** Instance-wide stored history, newest first (both directions). */
  async listRecent(instance, options = {}) {
    const { items, hasMore } = await this.repository.listRecent(instance.id, instance.tenantId, options);
    return {
      items: items.map(publicStoredMessage),
      hasMore,
      limitations: [
        'Only messages this gateway recorded are returned; retention governs whether message content is stored.',
        'Cloud API history contains inbound webhook messages and gateway-sent outbound messages only.',
      ],
    };
  }

  async getMessage(instance, messageId) {
    const row = await this.repository.findById(instance.id, instance.tenantId, messageId);
    return row ? publicStoredMessage(row) : null;
  }

  async listChats(instance, options = {}) {
    const { items, hasMore } = await this.repository.listChats(instance.id, instance.tenantId, options);
    return {
      items: items.map((chat) => ({
        chatId: chat.chatId,
        displayName: null, // The Cloud API exposes no chat/contact display name.
        isGroup: chat.chatId.includes('@g.us'),
        lastMessageAt: chat.lastMessageAt,
        messageCount: chat.messageCount,
        source: 'retained_inbound_webhook_messages',
      })),
      hasMore,
      limitations: [
        'Only inbound messages received by this gateway via webhooks are represented.',
        'No contact names, profile pictures or full history are available from the Cloud API.',
      ],
    };
  }

  async getChat(instance, chatId) {
    const chat = await this.repository.getChat(instance.id, instance.tenantId, chatId);
    if (!chat) throw new NotFoundError('Chat not found.');
    return {
      chatId: chat.chatId,
      displayName: null,
      isGroup: chat.chatId.includes('@g.us'),
      lastMessageAt: chat.lastMessageAt,
      messageCount: chat.messageCount,
      source: 'retained_inbound_webhook_messages',
    };
  }

  async listMessages(instance, chatId, options = {}) {
    const chat = await this.repository.getChat(instance.id, instance.tenantId, chatId);
    if (!chat) throw new NotFoundError('Chat not found.');
    const { items, hasMore } = await this.repository.listMessages(instance.id, instance.tenantId, chatId, options);
    return {
      items: items.map(publicStoredMessage),
      hasMore,
      limitations: [
        'Only inbound messages retained by this gateway are returned.',
        'Message content is stored only while retention is enabled for the instance.',
      ],
    };
  }

  async count(instance) {
    return this.repository.countByInstance(instance.id, instance.tenantId);
  }
}

export function publicStoredMessage(row) {
  return {
    id: row.providerMessageId,
    storedId: row.id,
    chatId: row.chatId,
    direction: row.direction,
    type: row.messageType,
    body: row.body,
    contentRetained: typeof row.body === 'string' && row.body.length > 0,
    from: row.fromId,
    to: row.toId,
    timestamp: row.sentAt,
    source: row.direction === 'outbound' ? 'retained_outbound_messages' : 'retained_inbound_webhook_messages',
  };
}
