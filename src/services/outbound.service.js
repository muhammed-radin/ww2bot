/**
 * Outbound messaging.
 *
 * The single place that turns an authorised RazorBills request into a WhatsApp
 * send. It validates the request, enforces a per-recipient rate limit (the
 * per-key and per-IP limits run as middleware), makes retries idempotent, and
 * records the minimum delivery metadata needed to troubleshoot a failure.
 *
 * Honesty rule: the status reported back is exactly what the connector can
 * verify. A Cloud API "accepted" means Meta accepted the request — it is NOT a
 * claim that the message was delivered to the handset. The gateway never
 * auto-retries an ambiguous send, because doing so could duplicate a message.
 */
import crypto from 'node:crypto';
import { CapabilityNotSupportedError, ErrorCode, RateLimitError, ValidationError } from '../utils/errors.js';
import { randomHex } from '../utils/ids.js';

const RECIPIENT_PATTERN = /^[1-9]\d{6,19}$/;
// A full WhatsApp chat id: <user>@<server>, e.g. 131355503402@c.us or a
// LID-based 33247392198739@lid. The WhatsApp Web connector needs the exact id;
// the Cloud API reduces it to the user part.
const CHAT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{2,32}$/;
const MAX_TEXT_LENGTH = 4096;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export const DeliveryStatus = Object.freeze({
  ACCEPTED: 'accepted',
  SENT: 'sent',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

export class OutboundService {
  constructor({ config, logger, connectionService, deliveries, audit, recipientStore, messageStore = null }) {
    this.config = config;
    this.logger = logger;
    this.connectionService = connectionService;
    this.deliveries = deliveries;
    this.audit = audit;
    this.recipientStore = recipientStore;
    this.messageStore = messageStore;
    this._digestKey = crypto.createHash('sha256').update(`idempotency:${config.security.apiKeyPepper}`).digest();
  }

  /** Stable digest so an idempotency key is never stored in the clear. */
  #idempotencyHash(instanceId, rawKey) {
    return crypto.createHmac('sha256', this._digestKey).update(`${instanceId}:${rawKey}`, 'utf8').digest('hex');
  }

  #recipientHash(instanceId, to) {
    return crypto.createHmac('sha256', this._digestKey).update(`to:${instanceId}:${to}`, 'utf8').digest('hex').slice(0, 32);
  }

  validate({ to, text, type }) {
    if (type !== undefined && type !== 'text') {
      throw new ValidationError('Only "text" messages are supported.', { field: 'type' });
    }
    if (typeof to !== 'string') {
      throw new ValidationError('"to" must be a phone number or a WhatsApp chat id.', { field: 'to' });
    }
    const trimmed = to.trim();
    let normalisedTo;
    if (trimmed.includes('@')) {
      if (!CHAT_ID_PATTERN.test(trimmed)) {
        throw new ValidationError('"to" must be a valid WhatsApp chat id (for example 131355503402@c.us).', {
          field: 'to',
        });
      }
      normalisedTo = trimmed;
    } else {
      const digits = trimmed.replace(/^\+/, '');
      if (!RECIPIENT_PATTERN.test(digits)) {
        throw new ValidationError(
          '"to" must be a phone number in international format (7-20 digits, no leading zero) or a WhatsApp chat id.',
          { field: 'to' },
        );
      }
      normalisedTo = digits;
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ValidationError('"text" must be a non-empty string.', { field: 'text' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(`"text" must not exceed ${MAX_TEXT_LENGTH} characters.`, { field: 'text', max: MAX_TEXT_LENGTH });
    }
    return { to: normalisedTo, text };
  }

  async #enforceRecipientLimit(instance, to) {
    const { windowMs, max } = this.config.server.rateLimit.recipient;
    const key = `send-recipient:${instance.id}:${this.#recipientHash(instance.id, to)}`;
    const { count, resetAt } = await this.recipientStore.increment(key, windowMs);
    if (count > max) {
      const retryAfterSeconds = Math.max(Math.ceil((resetAt - Date.now()) / 1000), 0);
      throw new RateLimitError('Too many messages to this recipient. Slow down.', {
        scope: 'send-recipient',
        limit: max,
        windowMs,
        retryAfterSeconds,
      });
    }
  }

  /**
   * Send a text message through the active connector.
   * @param {object} instance
   * @param {{keyId:string, tenantId:string}} auth
   * @param {{to:string, text:string, type?:string, idempotencyKey?:string|null,
   *          requestId?:string, ip?:string}} input
   */
  async send(instance, auth, { to, text, type, idempotencyKey = null, requestId = null, ip = null }) {
    if (!this.config.outbound.enabled) {
      throw new CapabilityNotSupportedError('Outbound messaging is disabled by configuration.', {
        connector: instance.connector,
        operation: 'sendMessage',
      });
    }

    const validated = this.validate({ to, text, type });

    let idempotencyKeyHash = null;
    if (idempotencyKey !== null && idempotencyKey !== undefined && idempotencyKey !== '') {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new ValidationError(`"Idempotency-Key" must be a string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`, {
          field: 'idempotencyKey',
        });
      }
      idempotencyKeyHash = this.#idempotencyHash(instance.id, idempotencyKey);
      const existing = await this.deliveries.findByIdempotency(instance.id, idempotencyKeyHash);
      if (existing && this.#withinIdempotencyWindow(existing)) {
        return {
          instanceId: instance.id,
          to: validated.to,
          status: existing.status,
          providerMessageId: existing.providerMessageId ?? null,
          acceptedAt: existing.createdAt,
          idempotent: true,
          connector: instance.connector,
        };
      }
    }

    await this.#enforceRecipientLimit(instance, validated.to);

    const connector = this.connectionService.requireConnector(instance, { createIfMissing: true });
    if (!connector.getCapabilities().outboundMessaging) {
      throw new CapabilityNotSupportedError(`The "${instance.connector}" connector cannot send messages.`, {
        connector: instance.connector,
        operation: 'sendMessage',
      });
    }

    const deliveryId = `dlv_${randomHex(12)}`;
    const createdAt = new Date();

    let result;
    try {
      result = await connector.sendMessage({ to: validated.to, text: validated.text });
    } catch (error) {
      await this.#record({
        id: deliveryId,
        instanceId: instance.id,
        tenantId: instance.tenantId,
        idempotencyKeyHash,
        recipient: validated.to,
        providerMessageId: null,
        status: DeliveryStatus.FAILED,
        errorCode: error?.code ?? ErrorCode.CONNECTOR_ERROR,
        createdAt,
        keyId: auth.keyId,
      });
      await this.audit?.record({
        action: 'message.send',
        result: 'failure',
        tenantId: instance.tenantId,
        instanceId: instance.id,
        requestId,
        actorKeyId: auth.keyId,
        ip,
        metadata: { connector: instance.connector, errorCode: error?.code ?? ErrorCode.CONNECTOR_ERROR },
      });
      throw error;
    }

    const status = normaliseStatus(result?.status);
    const record = await this.#record({
      id: deliveryId,
      instanceId: instance.id,
      tenantId: instance.tenantId,
      idempotencyKeyHash,
      recipient: validated.to,
      providerMessageId: result?.providerMessageId ?? null,
      status,
      errorCode: null,
      createdAt,
      keyId: auth.keyId,
    });

    // Record the outbound message so the instance-wide history includes it.
    // Retention-gated by the message store; a WhatsApp Web send is also seen on
    // `message_create` and de-duplicated by provider message id.
    if (this.messageStore && status !== DeliveryStatus.FAILED) {
      await this.messageStore
        .storeOutbound(instance, [
          {
            chatId: validated.to,
            providerMessageId: record.providerMessageId ?? `local_${deliveryId}`,
            messageType: 'text',
            body: validated.text,
            fromId: null,
            toId: validated.to,
            sentAt: createdAt,
            metadata: { source: instance.connector },
          },
        ])
        .catch((error) => {
          this.logger?.warn({ err: error, instanceId: instance.id }, 'failed to record an outbound message');
        });
    }

    await this.audit?.record({
      action: 'message.send',
      result: status === DeliveryStatus.FAILED ? 'failure' : 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      requestId,
      actorKeyId: auth.keyId,
      ip,
      metadata: { connector: instance.connector, status, providerMessageId: record.providerMessageId ?? null },
    });

    return {
      instanceId: instance.id,
      to: validated.to,
      status,
      providerMessageId: record.providerMessageId ?? null,
      acceptedAt: createdAt,
      idempotent: false,
      connector: instance.connector,
      ...(status === DeliveryStatus.ACCEPTED
        ? { note: 'Meta accepted the send request. Delivery to the handset is not confirmed.' }
        : {}),
    };
  }

  #withinIdempotencyWindow(record) {
    const ttl = this.config.outbound.idempotencyTtlMs;
    if (!ttl || ttl <= 0) return false;
    const age = Date.now() - new Date(record.createdAt).getTime();
    return age >= 0 && age <= ttl;
  }

  async #record(entry) {
    if (!this.config.outbound.enabled) return entry;
    try {
      return await this.deliveries.record(entry);
    } catch (error) {
      // Delivery metadata is best-effort: never fail a send because bookkeeping failed.
      this.logger?.warn({ err: error, instanceId: entry.instanceId }, 'failed to record delivery metadata');
      return entry;
    }
  }
}

function normaliseStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === DeliveryStatus.ACCEPTED || value === DeliveryStatus.SENT || value === DeliveryStatus.FAILED) return value;
  return DeliveryStatus.UNKNOWN;
}
