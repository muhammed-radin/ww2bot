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
const MAX_CAPTION_LENGTH = 1024;
const MAX_FILENAME_LENGTH = 255;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export const SEND_TYPES = Object.freeze([
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'reaction',
]);

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

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

  validate({
    to,
    type = 'text',
    text,
    media,
    caption,
    filename,
    voice,
    asDocument,
    asSticker,
    asGif,
    isViewOnce,
    location,
    contactId,
    contact,
    poll,
    messageId,
    reaction,
    replyToMessageId,
  }) {
    if (!SEND_TYPES.includes(type)) {
      throw new ValidationError(`"type" must be one of: ${SEND_TYPES.join(', ')}.`, { field: 'type' });
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

    const validated = { to: normalisedTo, type };

    if (type === 'text') {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new ValidationError('"text" must be a non-empty string.', { field: 'text' });
      }
      if (text.length > MAX_TEXT_LENGTH) {
        throw new ValidationError(`"text" must not exceed ${MAX_TEXT_LENGTH} characters.`, { field: 'text', max: MAX_TEXT_LENGTH });
      }
      validated.text = text;
    } else if (MEDIA_TYPES.has(type)) {
      if (!media || typeof media !== 'object') {
        throw new ValidationError('A media message requires a "media" object.', { field: 'media' });
      }
      const mimetype = typeof media.mimetype === 'string' ? media.mimetype.trim() : '';
      if (!mimetype || mimetype.length > 120 || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:\s*;.*)?$/.test(mimetype)) {
        throw new ValidationError('"media.mimetype" must be a valid MIME type.', { field: 'media.mimetype' });
      }
      const data = typeof media.data === 'string' ? media.data.replace(/\s/g, '') : '';
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new ValidationError('"media.data" must be base64-encoded bytes.', { field: 'media.data' });
      }
      const size = Buffer.byteLength(data, 'base64');
      const maxBytes = this.config.media?.maxUploadBytes ?? 16 * 1024 * 1024;
      if (size > maxBytes) {
        throw new ValidationError(`Media must not exceed ${maxBytes} bytes.`, { field: 'media.data', maxBytes });
      }
      if (caption !== undefined && caption !== null) {
        if (typeof caption !== 'string' || caption.length > MAX_CAPTION_LENGTH) {
          throw new ValidationError(`"caption" must not exceed ${MAX_CAPTION_LENGTH} characters.`, {
            field: 'caption',
            max: MAX_CAPTION_LENGTH,
          });
        }
      }
      if (filename !== undefined && filename !== null) {
        if (typeof filename !== 'string' || filename.length > MAX_FILENAME_LENGTH) {
          throw new ValidationError(`"filename" must not exceed ${MAX_FILENAME_LENGTH} characters.`, {
            field: 'filename',
            max: MAX_FILENAME_LENGTH,
          });
        }
      }
      validated.media = { mimetype, data, filename: filename ?? media.filename ?? null, size };
      validated.caption = caption ?? null;
      validated.voice = Boolean(voice) || type === 'voice';
      validated.asDocument = Boolean(asDocument) || type === 'document';
      validated.asSticker = Boolean(asSticker) || type === 'sticker';
      validated.asGif = Boolean(asGif);
      validated.isViewOnce = Boolean(isViewOnce);
    } else if (type === 'location') {
      const latitude = Number(location?.latitude);
      const longitude = Number(location?.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        throw new ValidationError('"location.latitude" must be between -90 and 90.', { field: 'location.latitude' });
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new ValidationError('"location.longitude" must be between -180 and 180.', { field: 'location.longitude' });
      }
      validated.location = {
        latitude,
        longitude,
        name: typeof location.name === 'string' ? location.name.slice(0, 200) : null,
        address: typeof location.address === 'string' ? location.address.slice(0, 500) : null,
        url: typeof location.url === 'string' ? location.url.slice(0, 500) : null,
      };
    } else if (type === 'contact') {
      if (contact && typeof contact === 'object') {
        const phone = typeof contact.phone === 'string' ? contact.phone.trim() : '';
        if (!RECIPIENT_PATTERN.test(phone.replace(/^\+/, ''))) {
          throw new ValidationError('"contact.phone" must be an international phone number.', { field: 'contact.phone' });
        }
        validated.contact = {
          name: typeof contact.name === 'string' ? contact.name.slice(0, 200) : null,
          phone,
          organization: typeof contact.organization === 'string' ? contact.organization.slice(0, 200) : null,
        };
      } else {
        if (typeof contactId !== 'string' || !CHAT_ID_PATTERN.test(contactId)) {
          throw new ValidationError('A contact message requires "contactId" or a "contact" object.', { field: 'contactId' });
        }
        validated.contactId = contactId;
      }
    } else if (type === 'poll') {
      const question = typeof poll?.question === 'string' ? poll.question.trim() : '';
      if (!question || question.length > 255) {
        throw new ValidationError('"poll.question" must be between 1 and 255 characters.', { field: 'poll.question' });
      }
      const options = Array.isArray(poll?.options)
        ? poll.options.map((option) => String(option ?? '').trim()).filter(Boolean)
        : [];
      if (options.length < 2 || options.length > 12) {
        throw new ValidationError('"poll.options" must contain between 2 and 12 options.', { field: 'poll.options' });
      }
      if (options.some((option) => option.length > 100)) {
        throw new ValidationError('Each poll option must not exceed 100 characters.', { field: 'poll.options' });
      }
      validated.poll = {
        question,
        options,
        allowMultipleAnswers: Boolean(poll.allowMultipleAnswers),
      };
    } else if (type === 'reaction') {
      if (typeof messageId !== 'string' || messageId.length < 3 || messageId.length > 200) {
        throw new ValidationError('"messageId" must be a valid message id.', { field: 'messageId' });
      }
      if (typeof reaction !== 'string' || reaction.length > 32) {
        throw new ValidationError('"reaction" must be an emoji string.', { field: 'reaction' });
      }
      validated.messageId = messageId;
      validated.reaction = reaction;
    }

    if (replyToMessageId !== undefined && replyToMessageId !== null) {
      if (typeof replyToMessageId !== 'string' || replyToMessageId.length < 3 || replyToMessageId.length > 200) {
        throw new ValidationError('"replyToMessageId" must be a valid message id.', { field: 'replyToMessageId' });
      }
      validated.replyToMessageId = replyToMessageId;
    }
    return validated;
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
   * Send a message through the active connector.
   * @param {object} instance
   * @param {{keyId:string, tenantId:string}} auth
   * @param {object} input validated by {@link validate}
   */
  async send(instance, auth, input) {
    if (!this.config.outbound.enabled) {
      throw new CapabilityNotSupportedError('Outbound messaging is disabled by configuration.', {
        connector: instance.connector,
        operation: 'sendMessage',
      });
    }

    const { idempotencyKey = null, requestId = null, ip = null, ...messageInput } = input;
    const validated = this.validate(messageInput);

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
          type: validated.type,
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
    const capabilities = connector.getCapabilities();
    if (!capabilities.outboundMessaging) {
      throw new CapabilityNotSupportedError(`The "${instance.connector}" connector cannot send messages.`, {
        connector: instance.connector,
        operation: 'sendMessage',
      });
    }
    this.#assertSendType(instance, capabilities, validated.type);

    const deliveryId = `dlv_${randomHex(12)}`;
    const createdAt = new Date();

    let result;
    try {
      if (validated.type === 'reaction') {
        result = await connector.sendReaction({
          chatId: validated.to,
          messageId: validated.messageId,
          reaction: validated.reaction,
        });
      } else {
        result = await connector.sendMessage({
          to: validated.to,
          type: validated.type,
          text: validated.text,
          media: validated.media,
          caption: validated.caption,
          filename: validated.media?.filename ?? null,
          voice: validated.voice,
          asDocument: validated.asDocument,
          asSticker: validated.asSticker,
          asGif: validated.asGif,
          isViewOnce: validated.isViewOnce,
          location: validated.location,
          contactId: validated.contactId,
          contact: validated.contact,
          poll: validated.poll,
          replyToMessageId: validated.replyToMessageId,
        });
      }
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
    // A connector may fall back to a different wire type (currently WhatsApp
    // Web sends an unprocessable image/video as a document). Store and report
    // what was actually sent, not only what the caller requested.
    const effectiveType = result?.type ?? validated.type;
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
    // Reactions are not messages and are not stored as rows. Retention gates
    // content; a WhatsApp Web send is also seen on `message_create` and
    // de-duplicated by provider message id.
    if (this.messageStore && status !== DeliveryStatus.FAILED && validated.type !== 'reaction') {
      await this.messageStore
        .storeOutbound(instance, [
          {
            chatId: validated.to,
            providerMessageId: record.providerMessageId ?? `local_${deliveryId}`,
            messageType: effectiveType,
            body: validated.text ?? validated.caption ?? null,
            fromId: null,
            toId: validated.to,
            sentAt: createdAt,
            metadata: {
              source: instance.connector,
              hasMedia: MEDIA_TYPES.has(effectiveType),
              media: validated.media
                ? {
                    mimetype: validated.media.mimetype,
                    filename: validated.media.filename,
                    size: validated.media.size,
                    isPtt: effectiveType === 'voice' || Boolean(validated.voice),
                  }
                : null,
              location: validated.location ?? null,
              poll: validated.poll
                ? {
                    question: validated.poll.question,
                    options: (validated.poll.options ?? []).map((name, localId) => ({
                      name: String(name),
                      localId,
                    })),
                    allowMultipleAnswers: Boolean(validated.poll.allowMultipleAnswers),
                  }
                : null,
              contacts: validated.contact
                ? [
                    {
                      name: validated.contact.name ?? null,
                      organization: validated.contact.organization ?? null,
                      phones: validated.contact.phone
                        ? [String(validated.contact.phone).replace(/[^\d+]/g, '')]
                        : [],
                    },
                  ]
                : null,
              replyToMessageId: validated.replyToMessageId ?? null,
            },
          },
        ])
        .catch((error) => {
          this.logger?.warn({ err: error, instanceId: instance.id }, 'failed to record an outbound message');
        });
    }

    await this.audit?.record({
      action: validated.type === 'reaction' ? 'message.react' : 'message.send',
      result: status === DeliveryStatus.FAILED ? 'failure' : 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      requestId,
      actorKeyId: auth.keyId,
      ip,
      metadata: {
        connector: instance.connector,
        type: effectiveType,
        status,
        providerMessageId: record.providerMessageId ?? null,
        ...(result?.fallback ? { fallback: result.fallback } : {}),
      },
    });

    return {
      instanceId: instance.id,
      to: validated.to,
      type: effectiveType,
      status,
      providerMessageId: record.providerMessageId ?? null,
      acceptedAt: createdAt,
      idempotent: false,
      connector: instance.connector,
      ...(result?.fallback ? { fallback: result.fallback, warning: result.warning } : {}),
      ...(status === DeliveryStatus.ACCEPTED
        ? { note: 'Meta accepted the send request. Delivery to the handset is not confirmed.' }
        : {}),
    };
  }

  /** Refuse a type the connector honestly does not support. */
  #assertSendType(instance, capabilities, type) {
    const supported =
      type === 'text'
        ? true
        : MEDIA_TYPES.has(type)
          ? Boolean(capabilities.sendMedia)
          : type === 'location'
            ? Boolean(capabilities.sendLocation)
            : type === 'contact'
              ? Boolean(capabilities.sendContact)
              : type === 'poll'
                ? Boolean(capabilities.sendPoll)
                : type === 'reaction'
                  ? Boolean(capabilities.sendReaction)
                  : false;
    if (!supported) {
      throw new CapabilityNotSupportedError(
        `The "${instance.connector}" connector cannot send "${type}" messages.`,
        { connector: instance.connector, operation: 'sendMessage', type },
      );
    }
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
