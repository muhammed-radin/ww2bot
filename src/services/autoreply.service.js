/**
 * Automatic replies.
 *
 * An operator defines per-instance rules (a literal match and a reply body).
 * When an inbound message matches an enabled rule the gateway sends the reply
 * through the instance's own connector. Rules are pure configuration: they
 * contain no credentials and the reply is only ever sent, never stored.
 *
 * Safety properties:
 *  - only inbound messages are considered, so a reply can never trigger itself;
 *  - an optional per-chat cooldown prevents a rule from spamming a conversation;
 *  - matching is deterministic and case handling is explicit;
 *  - a failure to reply is recorded and audited, never retried blindly.
 */
import {
  CapabilityNotSupportedError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../utils/errors.js';

export const MATCH_TYPES = Object.freeze(['exact', 'contains', 'prefix', 'regex']);

const MAX_RULES_PER_INSTANCE = 50;
const MAX_MATCH_VALUE = 500;
const MAX_REPLY_LENGTH = 4096;
const MAX_NAME_LENGTH = 80;
const MAX_COOLDOWN_SECONDS = 86400;

export class AutoReplyService {
  constructor({ config, logger, repository, connectionService, audit }) {
    this.config = config;
    this.logger = logger;
    this.repository = repository;
    this.connectionService = connectionService;
    this.audit = audit;
    this.cooldowns = new Map();
  }

  /* ------------------------------------------------------------------ */
  /* CRUD                                                                */
  /* ------------------------------------------------------------------ */

  async list(instance) {
    const rules = await this.repository.list(instance.id);
    return {
      items: rules.map(publicRule),
      limitations: [
        'Automatic replies are sent by the linked session; a reply is only attempted while the instance is connected.',
        'Group chats are not auto-replied: the outbound send path addresses direct chats only.',
      ],
    };
  }

  async get(instance, ruleId) {
    const rule = await this.repository.get(instance.id, ruleId);
    if (!rule) throw new NotFoundError('Automatic-reply rule not found.');
    return publicRule(rule);
  }

  async create(instance, input, { requestId = null, actorKeyId = null } = {}) {
    const existing = await this.repository.list(instance.id);
    if (existing.length >= MAX_RULES_PER_INSTANCE) {
      throw new ConflictError(undefined, `An instance may hold at most ${MAX_RULES_PER_INSTANCE} automatic-reply rules.`);
    }
    const rule = this.#validate(input, { partial: false });
    const created = await this.repository.create(instance.id, { ...rule, stats: emptyStats() });
    await this.audit?.record({
      action: 'autoreply.created',
      result: 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      requestId,
      actorKeyId,
      metadata: { ruleId: created.id },
    });
    return publicRule(created);
  }

  async update(instance, ruleId, input, { requestId = null, actorKeyId = null } = {}) {
    const current = await this.repository.get(instance.id, ruleId);
    if (!current) throw new NotFoundError('Automatic-reply rule not found.');
    const merged = {
      ...current,
      ...input,
      match: mergeDefined(current.match, input?.match),
      reply: mergeDefined(current.reply, input?.reply),
    };
    const rule = this.#validate(merged, { partial: true });
    const updated = await this.repository.update(instance.id, ruleId, rule);
    await this.audit?.record({
      action: 'autoreply.updated',
      result: 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      requestId,
      actorKeyId,
      metadata: { ruleId, enabled: updated?.enabled ?? null },
    });
    return publicRule(updated);
  }

  async remove(instance, ruleId, { requestId = null, actorKeyId = null } = {}) {
    const removed = await this.repository.remove(instance.id, ruleId);
    if (!removed) throw new NotFoundError('Automatic-reply rule not found.');
    this.#clearCooldownsForRule(instance.id, ruleId);
    await this.audit?.record({
      action: 'autoreply.deleted',
      result: 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      requestId,
      actorKeyId,
      metadata: { ruleId },
    });
    return { ruleId, deleted: true };
  }

  #validate(input, { partial }) {
    const source = input ?? {};
    const name = source.name ?? null;
    if (name !== null && (typeof name !== 'string' || name.length > MAX_NAME_LENGTH)) {
      throw new ValidationError(`"name" must be a string of at most ${MAX_NAME_LENGTH} characters.`, { field: 'name' });
    }

    const match = source.match ?? {};
    const type = match.type ?? 'exact';
    if (!MATCH_TYPES.includes(type)) {
      throw new ValidationError(`"match.type" must be one of: ${MATCH_TYPES.join(', ')}.`, { field: 'match.type' });
    }
    const value = typeof match.value === 'string' ? match.value : '';
    if (value.length === 0) throw new ValidationError('"match.value" must not be empty.', { field: 'match.value' });
    if (value.length > MAX_MATCH_VALUE) {
      throw new ValidationError(`"match.value" must not exceed ${MAX_MATCH_VALUE} characters.`, { field: 'match.value' });
    }
    if (type === 'regex') {
      try {
        // Compile once so an invalid pattern is rejected at write time.
        new RegExp(value, match.caseSensitive ? 'u' : 'iu');
      } catch {
        throw new ValidationError('"match.value" is not a valid regular expression.', { field: 'match.value' });
      }
    }

    const reply = source.reply ?? {};
    const text = typeof reply.text === 'string' ? reply.text : '';
    if (text.trim().length === 0) throw new ValidationError('"reply.text" must not be empty.', { field: 'reply.text' });
    if (text.length > MAX_REPLY_LENGTH) {
      throw new ValidationError(`"reply.text" must not exceed ${MAX_REPLY_LENGTH} characters.`, { field: 'reply.text' });
    }

    const cooldownSeconds = source.cooldownSeconds ?? 0;
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) {
      throw new ValidationError(`"cooldownSeconds" must be an integer between 0 and ${MAX_COOLDOWN_SECONDS}.`, {
        field: 'cooldownSeconds',
      });
    }

    const rule = {
      name,
      enabled: source.enabled !== false,
      match: { type, value, caseSensitive: Boolean(match.caseSensitive) },
      reply: { text },
      cooldownSeconds,
    };
    if (!partial && source.enabled === undefined) rule.enabled = true;
    return rule;
  }

  /* ------------------------------------------------------------------ */
  /* runtime                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Evaluate an inbound message against the instance's enabled rules and send
   * the first matching reply. Never throws: a failure is logged, recorded and
   * audited so it surfaces without breaking message recording.
   */
  async handleInbound(instance, message) {
    if (!message || message.direction !== 'inbound') return { matched: false };
    const body = typeof message.body === 'string' ? message.body : null;
    if (body === null || body.trim() === '') return { matched: false };

    const target = directRecipient(message.chatId);
    if (!target) return { matched: false, skipped: 'not_a_direct_chat' };

    let rules;
    try {
      rules = (await this.repository.list(instance.id)).filter((rule) => rule.enabled);
    } catch (error) {
      this.logger?.warn({ err: error, instanceId: instance.id }, 'failed to load automatic-reply rules');
      return { matched: false, error: 'rules_unavailable' };
    }
    if (rules.length === 0) return { matched: false };

    const rule = rules.find((candidate) => matches(candidate.match, body));
    if (!rule) return { matched: false };

    if (!this.#cooldownElapsed(instance.id, rule.id, message.chatId)) {
      await this.repository.recordOutcome(instance.id, rule.id, { matched: true });
      return { matched: true, sent: false, reason: 'cooldown' };
    }

    try {
      const connector = this.connectionService.requireConnector(instance);
      if (!connector.getCapabilities().outboundMessaging) {
        throw new CapabilityNotSupportedError('The selected connector cannot send messages.', {
          connector: instance.connector,
          operation: 'sendMessage',
        });
      }
      await connector.sendMessage({ to: target, text: rule.reply.text });
      this.#markCooldown(instance.id, rule.id, message.chatId, rule.cooldownSeconds);
      await this.repository.recordOutcome(instance.id, rule.id, { matched: true, replied: true });
      await this.audit?.record({
        action: 'autoreply.sent',
        result: 'success',
        tenantId: instance.tenantId,
        instanceId: instance.id,
        metadata: { ruleId: rule.id, chatId: message.chatId, messageId: message.id ?? null },
      });
      return { matched: true, sent: true, ruleId: rule.id };
    } catch (error) {
      await this.repository.recordOutcome(instance.id, rule.id, { matched: true, error: error?.message ?? 'send failed' });
      await this.audit?.record({
        action: 'autoreply.sent',
        result: 'failure',
        tenantId: instance.tenantId,
        instanceId: instance.id,
        metadata: { ruleId: rule.id, errorCode: error?.code ?? 'ERROR' },
      });
      this.logger?.warn({ err: error, instanceId: instance.id, ruleId: rule.id }, 'automatic reply could not be sent');
      return { matched: true, sent: false, error: error?.code ?? 'ERROR' };
    }
  }

  #cooldownKey(instanceId, ruleId, chatId) {
    return `${instanceId}:${ruleId}:${chatId}`;
  }

  #cooldownElapsed(instanceId, ruleId, chatId) {
    const key = this.#cooldownKey(instanceId, ruleId, chatId);
    const until = this.cooldowns.get(key) ?? 0;
    return Date.now() >= until;
  }

  #markCooldown(instanceId, ruleId, chatId, seconds) {
    if (!seconds || seconds <= 0) return;
    this.cooldowns.set(this.#cooldownKey(instanceId, ruleId, chatId), Date.now() + seconds * 1000);
    // Opportunistic cleanup so the map cannot grow without bound.
    if (this.cooldowns.size > 5000) {
      const now = Date.now();
      for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    }
  }

  #clearCooldownsForRule(instanceId, ruleId) {
    const prefix = `${instanceId}:${ruleId}:`;
    for (const key of this.cooldowns.keys()) if (key.startsWith(prefix)) this.cooldowns.delete(key);
  }
}

/** Match a message body against one rule, honouring case sensitivity. */
export function matches(match, body) {
  const { type, value } = match ?? {};
  if (!type || typeof value !== 'string') return false;
  const caseSensitive = Boolean(match.caseSensitive);
  if (type === 'regex') {
    try {
      return new RegExp(value, caseSensitive ? 'u' : 'iu').test(body);
    } catch {
      return false;
    }
  }
  const left = caseSensitive ? body : body.toLowerCase();
  const right = caseSensitive ? value : value.toLowerCase();
  if (type === 'exact') return left === right;
  if (type === 'contains') return left.includes(right);
  if (type === 'prefix') return left.startsWith(right);
  return false;
}

/**
 * The exact chat id to reply to, or null when the chat is not a direct
 * conversation.
 *
 * The id is returned unchanged: modern WhatsApp uses LID-based ids (`...@lid`)
 * for direct chats as well as phone-number ids (`...@c.us`), and rewriting a
 * LID to a phone number addresses the wrong (or a non-existent) chat. Cloud API
 * webhooks carry a bare phone number, which is passed through as-is.
 */
export function directRecipient(chatId) {
  if (typeof chatId !== 'string') return null;
  if (/@(g\.us|broadcast|newsletter)$/i.test(chatId)) return null;
  if (/^[1-9]\d{6,19}$/.test(chatId)) return chatId;
  if (/^[A-Za-z0-9._-]{1,64}@(c\.us|lid)$/i.test(chatId)) return chatId;
  return null;
}

function emptyStats() {
  return { matches: 0, replies: 0, failures: 0, lastMatchedAt: null, lastError: null };
}

/** Merge a partial patch over a base object, ignoring explicit `undefined`. */
function mergeDefined(base, patch) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function publicRule(rule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match,
    reply: rule.reply,
    cooldownSeconds: rule.cooldownSeconds,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    stats: rule.stats,
  };
}
