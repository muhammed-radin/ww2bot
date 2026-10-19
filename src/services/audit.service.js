/**
 * Audit trail.
 *
 * Audit records answer "who did what, to which resource, with what result".
 * They are deliberately narrow: no message bodies, no QR payloads, no pairing
 * codes, no API keys and no session material are ever written. A recursive
 * redactor is applied as a second line of defence.
 */
import { newAuditEventId } from '../utils/ids.js';

const FORBIDDEN_KEY_PATTERN =
  /(api[-_]?key|secret|password|passwd|token|authorization|cookie|session|qr|pairing|otp|credential|private[-_]?key)/i;
const CONTENT_KEY_PATTERN = /^(body|text|message|messages|content|payload|raw|media)$/i;
const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 5;

export function redactForAudit(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactForAudit(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key)) {
        result[key] = '[REDACTED]';
        continue;
      }
      result[key] = redactForAudit(nested, depth + 1);
    }
    return result;
  }
  return '[UNSERIALISABLE]';
}

export class AuditService {
  constructor({ repository, logger }) {
    this.repository = repository;
    this.logger = logger;
  }

  /**
   * Persist an audit event. Never throws into the request path: an audit
   * failure is logged but must not break a legitimate operation.
   */
  async record({
    action,
    result = 'success',
    tenantId = null,
    instanceId = null,
    requestId = null,
    actorKeyId = null,
    ip = null,
    userAgent = null,
    metadata = null,
  }) {
    const event = {
      id: newAuditEventId(),
      tenantId,
      instanceId,
      action,
      result,
      requestId,
      actorKeyId,
      ip,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : null,
      metadata: metadata ? redactForAudit(metadata) : null,
      createdAt: new Date(),
    };
    try {
      return await this.repository.create(event);
    } catch (error) {
      this.logger?.error({ err: error, action, result }, 'failed to persist audit event');
      return null;
    }
  }

  async list({ tenantId, instanceId = null, limit = 100, offset = 0 } = {}) {
    return this.repository.list({ tenantId, instanceId, limit, offset });
  }

  async purgeOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 86400000);
    return this.repository.deleteOlderThan(cutoff);
  }
}
