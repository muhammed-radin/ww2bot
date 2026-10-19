/**
 * Owner administration sessions (ww2web dashboard).
 *
 * The owner signs in to the dashboard with an **owner API key** — the same
 * credential the CLI (`npm run key:create -- --preset owner`) issues. The key is
 * presented exactly once, over the login request, and is never stored anywhere.
 *
 * On success a *server-side* session is created:
 *   - the bearer value is 32 random bytes returned to the browser only inside an
 *     HttpOnly cookie, so JavaScript can never read it;
 *   - only an HMAC digest of that value is kept in memory, so a memory dump or a
 *     log line cannot reveal a usable session;
 *   - a per-session CSRF token is returned in the response body (readable by the
 *     app, not by a cross-site page) and must accompany every state-changing
 *     request that is authenticated by the cookie.
 *
 * Sessions live in this process only. Restarting the service invalidates them,
 * which is the correct trade-off for a single-owner, filesystem-backed
 * deployment: no session material is ever written to disk.
 *
 * Design note: the RazorBills service key (scopes: `messages:send` …) can never
 * open a session, because a session requires the owner-only scopes
 * (`auth:manage` + `keys:manage`). Messaging-service credentials and owner
 * administration are therefore fully separated.
 */
import crypto from 'node:crypto';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { OWNER_SCOPES } from '../config/security.js';
import { ApiKeyService } from './apiKey.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_API_KEY_LENGTH = 256;
const MAX_COOKIE_HEADER_LENGTH = 8192;

/** True when the HTTP method can change state and therefore needs CSRF cover. */
export function isStateChangingMethod(method) {
  return !SAFE_METHODS.has(String(method ?? 'GET').toUpperCase());
}

/** Parse a single cookie value from a raw `Cookie` header without extra deps. */
export function readCookie(req, name) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_COOKIE_HEADER_LENGTH) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value === '' ? null : decodeURIComponent(value);
  }
  return null;
}

export class OwnerSessionService {
  constructor({ config, apiKeyService, logger, audit }) {
    this.config = config;
    this.apiKeyService = apiKeyService;
    this.logger = logger;
    this.audit = audit;

    this.cookieName = config.ownerSession.cookieName;
    this.ttlMs = config.ownerSession.ttlMs;
    this.idleMs = config.ownerSession.idleMs;
    this.maxSessions = config.ownerSession.maxSessions;

    // Derive the session-digest key from the API key pepper (already required in
    // production) so no additional secret has to be provisioned.
    this._secret = crypto.createHash('sha256').update(`owner-session:${config.security.apiKeyPepper}`).digest();
    this.sessions = new Map(); // digest -> record
  }

  #digest(token) {
    return crypto.createHmac('sha256', this._secret).update(String(token), 'utf8').digest('hex');
  }

  #prune(now = Date.now()) {
    for (const [key, record] of this.sessions) {
      if (record.expiresAt <= now || now - record.lastSeenAt >= this.idleMs) this.sessions.delete(key);
    }
  }

  #evictOldest() {
    while (this.sessions.size > this.maxSessions) {
      let oldestKey = null;
      let oldestSeen = Infinity;
      for (const [key, record] of this.sessions) {
        if (record.lastSeenAt < oldestSeen) {
          oldestSeen = record.lastSeenAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
    }
  }

  ownerView(record) {
    return {
      keyId: record.keyId,
      name: record.name ?? null,
      tenantId: record.tenantId,
      scopes: [...record.scopes],
      createdAt: new Date(record.createdAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  /**
   * Exchange an owner API key for a browser session.
   * @returns {Promise<{token:string, csrfToken:string, owner:object, expiresAt:string}>}
   */
  async login({ apiKey, requestId = null, ip = null, userAgent = null } = {}) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '' || apiKey.length > MAX_API_KEY_LENGTH) {
      throw new UnauthorizedError('Enter your owner API key to sign in.');
    }

    const auth = await this.apiKeyService.verify(apiKey.trim(), { requestId, ip });

    const missing = OWNER_SCOPES.filter((scope) => !ApiKeyService.hasScope(auth, scope));
    if (missing.length > 0) {
      await this.audit?.record({
        action: 'owner.login',
        result: 'failure',
        tenantId: auth.tenantId,
        requestId,
        actorKeyId: auth.keyId,
        ip,
        userAgent,
        metadata: { reason: 'insufficient_scope', missingScopes: missing },
      });
      // Same shape as an invalid key: the dashboard reports one friendly message.
      throw new ForbiddenError('This API key cannot administer the service. Owner keys hold both auth:manage and keys:manage.', {
        missingScopes: missing,
      });
    }

    const now = Date.now();
    this.#prune(now);

    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const record = {
      digest: this.#digest(token),
      keyId: auth.keyId,
      tenantId: auth.tenantId,
      scopes: [...auth.scopes],
      name: auth.name ?? null,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.sessions.set(record.digest, record);
    this.#evictOldest();

    await this.audit?.record({
      action: 'owner.login',
      result: 'success',
      tenantId: auth.tenantId,
      requestId,
      actorKeyId: auth.keyId,
      ip,
      userAgent,
      metadata: { sessions: this.sessions.size },
    });

    return { token, csrfToken, owner: this.ownerView(record), expiresAt: new Date(record.expiresAt).toISOString() };
  }

  /** Resolve a session by its bearer token, applying the idle timeout. */
  resolve(token) {
    if (typeof token !== 'string' || token === '') return null;
    const digest = this.#digest(token);
    const record = this.sessions.get(digest);
    if (!record) return null;
    const now = Date.now();
    if (record.expiresAt <= now || now - record.lastSeenAt >= this.idleMs) {
      this.sessions.delete(digest);
      return null;
    }
    record.lastSeenAt = now;
    return record;
  }

  /** Resolve the session named by the request's cookie, or null. */
  resolveFromRequest(req) {
    return this.resolve(readCookie(req, this.cookieName));
  }

  /** Build the `req.auth` context for a session (never grants an instance allowlist). */
  authFor(record) {
    return {
      keyId: record.keyId,
      tenantId: record.tenantId,
      scopes: [...record.scopes],
      allowedInstanceIds: null,
      name: record.name ?? null,
      source: 'session',
    };
  }

  /** Constant-time CSRF check for cookie-authenticated state-changing requests. */
  assertCsrf(record, token) {
    if (typeof token !== 'string' || token === '') {
      throw new ForbiddenError('A CSRF token is required for this request.', { code: 'CSRF_REQUIRED' });
    }
    const presented = Buffer.from(String(token), 'utf8');
    const expected = Buffer.from(record.csrfToken, 'utf8');
    const matches = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
    if (!matches) throw new ForbiddenError('The CSRF token is invalid.', { code: 'CSRF_REQUIRED' });
  }

  async logout(token, { requestId = null, ip = null, reason = 'owner_logout' } = {}) {
    const record = this.resolve(token);
    if (!record) return { revoked: false };
    this.sessions.delete(record.digest);
    await this.audit?.record({
      action: 'owner.logout',
      result: 'success',
      tenantId: record.tenantId,
      requestId,
      actorKeyId: record.keyId,
      ip,
      metadata: { reason },
    });
    return { revoked: true };
  }

  /** Drop every live session for a key (used when a key is revoked). */
  revokeForKey(keyId) {
    let removed = 0;
    for (const [key, record] of this.sessions) {
      if (record.keyId === keyId) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: Boolean(this.config.ownerSession.cookieSecure),
      path: '/',
      maxAge: this.ttlMs,
    };
  }

  clearCookieOptions() {
    const { maxAge, ...rest } = this.cookieOptions();
    return rest;
  }

  get size() {
    return this.sessions.size;
  }

  shutdown() {
    this.sessions.clear();
  }
}
