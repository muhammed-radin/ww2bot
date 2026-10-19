/**
 * Cloud API webhook handling.
 *
 * Security and correctness guarantees:
 *  - X-Hub-Signature-256 is verified against the raw request bytes with a
 *    constant-time comparison before anything is parsed or acted upon.
 *  - Deliveries are idempotent: each provider event id is recorded once, so a
 *    Meta retry is acknowledged without double-processing.
 *  - Message content is only persisted when retention is explicitly enabled for
 *    the instance; otherwise the body is discarded after the event is emitted.
 *  - Signature failures and duplicates are audited without logging payloads.
 */
import crypto from 'node:crypto';
import { ServiceUnavailableError } from '../utils/errors.js';
import { ConnectionEventType } from '../events/connectionEvents.js';
import { ConnectorType } from './instance.service.js';

export class WebhookService {
  constructor({ config, logger, repositories, messageStore, events, audit, autoReply = null }) {
    this.config = config;
    this.logger = logger;
    this.repositories = repositories;
    this.messageStore = messageStore;
    this.events = events;
    this.audit = audit;
    this.autoReply = autoReply;
  }

  get configured() {
    return Boolean(this.config.connectors.cloud.appSecret && this.config.connectors.cloud.verifyToken);
  }

  assertConfigured() {
    if (!this.config.connectors.cloud.appSecret) {
      throw new ServiceUnavailableError('Webhook signature verification is not configured (META_APP_SECRET is unset).');
    }
  }

  /**
   * Verify the Meta signature header against the raw body.
   * @param {Buffer|string} rawBody
   * @param {string|undefined} signatureHeader value of X-Hub-Signature-256
   */
  verifySignature(rawBody, signatureHeader) {
    this.assertConfigured();
    if (typeof signatureHeader !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) {
      return false;
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const expected = `sha256=${crypto
      .createHmac('sha256', this.config.connectors.cloud.appSecret)
      .update(body)
      .digest('hex')}`;
    const provided = Buffer.from(signatureHeader.toLowerCase(), 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
  }

  /** GET verification handshake from Meta. */
  verifyChallenge({ mode, token, challenge }) {
    if (!this.config.connectors.cloud.verifyToken) {
      throw new ServiceUnavailableError('Webhook verification is not configured (META_VERIFY_TOKEN is unset).');
    }
    if (mode !== 'subscribe') return { ok: false, reason: 'invalid_mode' };
    if (typeof token !== 'string' || typeof challenge !== 'string') return { ok: false, reason: 'missing_parameters' };
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(challenge)) return { ok: false, reason: 'invalid_challenge' };

    const provided = Buffer.from(token, 'utf8');
    const expected = Buffer.from(this.config.connectors.cloud.verifyToken, 'utf8');
    const matches = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    return matches ? { ok: true, challenge } : { ok: false, reason: 'invalid_token' };
  }

  async resolveInstance(phoneNumberId) {
    const instances = await this.repositories.instances.listAll({ limit: 5000 });
    const fallbackId = this.config.connectors.cloud.phoneNumberId;
    return (
      instances.find((instance) => {
        if (instance.connector !== ConnectorType.CLOUD_API) return false;
        const effective = instance.metadata?.phoneNumberId ?? fallbackId;
        return effective === phoneNumberId;
      }) ?? null
    );
  }

  /**
   * Process a verified webhook payload.
   * @returns {Promise<{messages:number, statuses:number, duplicates:number, unmatched:number}>}
   */
  async handleCloudPayload({ payload, requestId = null }) {
    const summary = { messages: 0, statuses: 0, duplicates: 0, unmatched: 0 };

    if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
      await this.audit?.record({
        action: 'webhook.received',
        result: 'failure',
        requestId,
        metadata: { reason: 'unsupported_object', object: payload?.object ?? null },
      });
      return summary;
    }

    for (const entry of payload.entry) {
      if (!Array.isArray(entry?.changes)) continue;
      for (const change of entry.changes) {
        if (change?.field !== 'messages') continue;
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id ?? null;
        const instance = await this.resolveInstance(phoneNumberId);

        if (!instance) {
          summary.unmatched += 1;
          await this.audit?.record({
            action: 'webhook.received',
            result: 'failure',
            requestId,
            metadata: { reason: 'no_matching_instance', phoneNumberId },
          });
          continue;
        }

        const inbound = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];

        const retained = [];
        for (const message of inbound) {
          if (!message?.id) continue;
          const { isDuplicate } = await this.repositories.webhookEvents.recordIfNew({
            providerEventId: `msg:${message.id}`,
            instanceId: instance.id,
            eventType: 'message',
            receivedAt: new Date(),
          });
          if (isDuplicate) {
            summary.duplicates += 1;
            continue;
          }
          summary.messages += 1;
          retained.push(normaliseInboundMessage(message));
        }

        for (const status of statuses) {
          if (!status?.id) continue;
          const { isDuplicate } = await this.repositories.webhookEvents.recordIfNew({
            providerEventId: `status:${status.id}:${status.status ?? 'unknown'}`,
            instanceId: instance.id,
            eventType: 'status',
            receivedAt: new Date(),
          });
          if (isDuplicate) {
            summary.duplicates += 1;
          } else {
            summary.statuses += 1;
          }
        }

        if (retained.length > 0) {
          const storeResult = await this.messageStore.storeInbound(instance, retained);
          // Emit only metadata: message bodies stay out of the event stream.
          for (const message of retained) {
            await this.events?.publish(instance.id, ConnectionEventType.MESSAGE, {
              connector: ConnectorType.CLOUD_API,
              chatId: message.chatId,
              messageId: message.providerMessageId,
              type: message.messageType,
              timestamp: message.sentAt.toISOString(),
              contentRetained: storeResult.retentionEnabled,
            });
          }
          // Automatic replies see the body directly (never via the bus) and
          // run whether or not content retention is enabled.
          if (this.autoReply) {
            for (const message of retained) {
              await this.autoReply.handleInbound(instance, {
                id: message.providerMessageId,
                chatId: message.chatId,
                direction: 'inbound',
                type: message.messageType,
                body: message.body,
                from: message.fromId,
                to: message.toId,
                timestamp: message.sentAt.toISOString(),
              });
            }
          }
        }

        for (const error of Array.isArray(value.errors) ? value.errors : []) {
          this.logger?.warn(
            {
              instanceId: instance.id,
              providerCode: error?.code ?? null,
              providerTitle: error?.title ?? null,
            },
            'cloud api reported a webhook error for this instance',
          );
        }
      }
    }

    await this.audit?.record({
      action: 'webhook.processed',
      result: 'success',
      requestId,
      metadata: summary,
    });

    return summary;
  }
}

/** Convert a Cloud API inbound message into the gateway's storage shape. */
export function normaliseInboundMessage(message) {
  const sentAt = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
  const { type, body } = extractBody(message);
  return {
    chatId: message.from,
    providerMessageId: message.id,
    direction: 'inbound',
    messageType: type,
    // Only the textual representation is kept; media is not downloaded.
    body,
    fromId: message.from ?? null,
    toId: null,
    sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
    metadata: {
      contextMessageId: message.context?.id ?? null,
      forwarded: Boolean(message.context?.forwarded),
    },
  };
}

function extractBody(message) {
  switch (message.type) {
    case 'text':
      return { type: 'text', body: message.text?.body ?? null };
    case 'button':
      return { type: 'button', body: message.button?.text ?? null };
    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply ?? null;
      return { type: 'interactive', body: reply?.title ?? null };
    }
    case 'reaction':
      return { type: 'reaction', body: message.reaction?.emoji ?? null };
    case 'location':
      return { type: 'location', body: null };
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      return { type: message.type, body: message[message.type]?.caption ?? null };
    default:
      return { type: message.type ?? 'unknown', body: null };
  }
}
