/**
 * Single-use, short-lived stream tokens.
 *
 * Browser EventSource cannot send an X-API-Key header, and putting a long-lived
 * API key in a URL would leak it into access logs, proxies and browser history.
 * Instead a client exchanges its API key (over a normal authenticated request)
 * for a stream token that:
 *   - expires after STREAM_TOKEN_TTL_MS,
 *   - is bound to one instance, tenant and scope set,
 *   - can be used exactly once,
 *   - is stored only as a SHA-256 digest, so the token itself is never at rest.
 */
import crypto from 'node:crypto';
import { ErrorCode, UnauthorizedError } from '../utils/errors.js';

export class StreamTokenService {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.prefix = 'stt:';
    this.memory = new Map();
  }

  #digest(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Issue a stream token for one instance.
   * @param {{auth:object, instanceId:string}} options
   * @returns {Promise<{token:string, expiresAt:string, expiresInMs:number}>}
   */
  async issue({ auth, instanceId }) {
    const ttlMs = this.config.events.streamTokenTtlMs;
    const token = crypto.randomBytes(32).toString('base64url');
    const payload = {
      keyId: auth.keyId,
      tenantId: auth.tenantId,
      scopes: auth.scopes,
      allowedInstanceIds: auth.allowedInstanceIds ?? null,
      instanceId,
      expiresAt: Date.now() + ttlMs,
    };
    const key = `${this.prefix}${this.#digest(token)}`;

    this.#prune();
    this.memory.set(key, payload);

    return { token, expiresAt: new Date(payload.expiresAt).toISOString(), expiresInMs: ttlMs };
  }

  /**
   * Consume a stream token. Returns the bound authorisation context, or throws
   * UnauthorizedError when the token is unknown, expired or already used.
   */
  async consume(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) {
      throw new UnauthorizedError('The stream token is invalid.', { code: ErrorCode.INVALID_STREAM_TOKEN });
    }
    const key = `${this.prefix}${this.#digest(token)}`;
    const raw = this.memory.get(key) ?? null;
    this.memory.delete(key);

    if (!raw) {
      throw new UnauthorizedError('The stream token is invalid or has already been used.', {
        code: ErrorCode.INVALID_STREAM_TOKEN,
      });
    }

    let payload;
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new UnauthorizedError('The stream token is invalid.', { code: ErrorCode.INVALID_STREAM_TOKEN });
    }

    if (!payload.expiresAt || payload.expiresAt <= Date.now()) {
      throw new UnauthorizedError('The stream token has expired.', { code: ErrorCode.INVALID_STREAM_TOKEN });
    }

    return {
      keyId: payload.keyId,
      tenantId: payload.tenantId,
      scopes: payload.scopes ?? [],
      allowedInstanceIds: payload.allowedInstanceIds ?? null,
      instanceId: payload.instanceId,
    };
  }

  #prune() {
    const now = Date.now();
    for (const [key, payload] of this.memory.entries()) {
      if (payload.expiresAt <= now) this.memory.delete(key);
    }
    // Hard cap protects the process from unbounded token issuance.
    const MAX = 5000;
    if (this.memory.size > MAX) {
      const excess = this.memory.size - MAX;
      let removed = 0;
      for (const key of this.memory.keys()) {
        this.memory.delete(key);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }
}
