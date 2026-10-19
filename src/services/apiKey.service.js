/**
 * API key lifecycle: generation, verification, rotation and revocation.
 *
 * Security properties:
 *  - 32 random bytes (256 bits) of entropy from the CSPRNG.
 *  - The plaintext key is returned exactly once, at creation, and is never
 *    persisted or logged. Only an HMAC-SHA256 digest keyed with a server-side
 *    pepper is stored.
 *  - Lookup is by the non-secret key id, and verification uses a constant-time
 *    comparison, so responses do not leak which part of a key was wrong.
 *  - Keys carry explicit scopes and an optional instance allowlist; a key can
 *    only ever touch its own tenant, and only the instances it was granted.
 */
import crypto from 'node:crypto';
import {
  API_KEY_ID_PATTERN,
  API_KEY_PREFIX,
  API_KEY_SECRET_BYTES,
  API_KEY_SECRET_PATTERN,
  ALL_SCOPES,
} from '../config/security.js';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors.js';
import { newApiKeyId, newUuid } from '../utils/ids.js';

const WILDCARD = '*';
const MAX_KEY_LENGTH = 256;

// Anchored parse: the base64url secret alphabet includes "_", so a naive
// split on the separator would truncate ~half of all keys. Fixed-length
// capture groups make parsing unambiguous.
const KEY_PATTERN = /^wak_([a-f0-9]{18})_([A-Za-z0-9_-]{43})$/;

export class ApiKeyService {
  constructor({ repository, config, logger, audit }) {
    this.repository = repository;
    this.config = config;
    this.logger = logger;
    this.audit = audit;
    this._pepper = Buffer.from(config.security.apiKeyPepper, 'utf8');
  }

  /* ------------------------------------------------------------------ */
  /* hashing                                                             */
  /* ------------------------------------------------------------------ */

  hashKey(fullKey) {
    return crypto.createHmac('sha256', this._pepper).update(fullKey, 'utf8').digest('hex');
  }

  /* ------------------------------------------------------------------ */
  /* generation                                                          */
  /* ------------------------------------------------------------------ */

  validateScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new ValidationError('At least one scope is required.', { field: 'scopes' });
    }
    const unique = [...new Set(scopes)];
    for (const scope of unique) {
      if (scope !== WILDCARD && !ALL_SCOPES.includes(scope)) {
        throw new ValidationError(`Unknown scope "${scope}".`, {
          field: 'scopes',
          allowed: [...ALL_SCOPES, WILDCARD],
        });
      }
    }
    if (unique.includes(WILDCARD) && unique.length > 1) {
      throw new ValidationError('The wildcard scope "*" cannot be combined with other scopes.', { field: 'scopes' });
    }
    return unique;
  }

  /**
   * Create a new API key.
   * @returns {Promise<{plaintext:string, record:object}>} plaintext is shown once
   */
  async generate({
    tenantId,
    name,
    scopes,
    expiresAt = null,
    allowedInstanceIds = null,
    createdBy = null,
    actorScopes = null,
    requestId = null,
    ip = null,
    ttlDays,
  }) {
    if (!tenantId || typeof tenantId !== 'string' || !/^[\w.:-]{1,64}$/.test(tenantId)) {
      throw new ValidationError('"tenantId" is required and must match [A-Za-z0-9_.:-]{1,64}.', { field: 'tenantId' });
    }
    const normalisedScopes = this.validateScopes(scopes);

    // Privilege-escalation guard: a caller may never grant more than it holds.
    if (actorScopes) {
      const actorHoldsWildcard = actorScopes.includes(WILDCARD);
      if (normalisedScopes.includes(WILDCARD) && !actorHoldsWildcard) {
        throw new ForbiddenError('Only an owner key may create a wildcard key.', { field: 'scopes' });
      }
      const escalated = normalisedScopes.filter(
        (scope) => scope !== WILDCARD && !actorHoldsWildcard && !actorScopes.includes(scope),
      );
      if (escalated.length > 0) {
        throw new ForbiddenError('Cannot grant scopes the caller does not hold.', { escalatedScopes: escalated });
      }
    }

    let resolvedExpiry = null;
    if (expiresAt) {
      resolvedExpiry = new Date(expiresAt);
      if (Number.isNaN(resolvedExpiry.getTime())) {
        throw new ValidationError('"expiresAt" must be a valid ISO-8601 timestamp.', { field: 'expiresAt' });
      }
    } else {
      const days = ttlDays ?? this.config.security.apiKeyDefaultTtlDays;
      if (days > 0) resolvedExpiry = new Date(Date.now() + days * 86400000);
    }

    if (allowedInstanceIds !== null) {
      if (!Array.isArray(allowedInstanceIds) || allowedInstanceIds.some((id) => typeof id !== 'string')) {
        throw new ValidationError('"allowedInstanceIds" must be an array of instance ids or null.', {
          field: 'allowedInstanceIds',
        });
      }
      if (allowedInstanceIds.length === 0) {
        throw new ValidationError('"allowedInstanceIds" must not be an empty array; use null for "all tenant instances".', {
          field: 'allowedInstanceIds',
        });
      }
    }

    const keyId = newApiKeyId();
    const secret = crypto.randomBytes(API_KEY_SECRET_BYTES).toString('base64url');
    const plaintext = `${API_KEY_PREFIX}_${keyId}_${secret}`;
    const record = {
      id: newUuid(),
      keyId,
      keyHash: this.hashKey(plaintext),
      tenantId,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : 'api-key',
      scopes: normalisedScopes,
      allowedInstanceIds,
      createdAt: new Date(),
      expiresAt: resolvedExpiry,
      revokedAt: null,
      lastUsedAt: null,
      createdBy,
    };

    const saved = await this.repository.create(record);
    await this.audit?.record({
      action: 'api_key.created',
      result: 'success',
      tenantId,
      requestId,
      actorKeyId: createdBy,
      ip,
      metadata: { keyId, scopes: normalisedScopes, expiresAt: resolvedExpiry?.toISOString() ?? null },
    });

    return { plaintext, record: saved };
  }

  /* ------------------------------------------------------------------ */
  /* verification                                                        */
  /* ------------------------------------------------------------------ */

  parseKey(fullKey) {
    if (typeof fullKey !== 'string' || fullKey.length === 0 || fullKey.length > MAX_KEY_LENGTH) return null;
    const match = KEY_PATTERN.exec(fullKey);
    if (!match) return null;
    const [, keyId, secret] = match;
    if (!API_KEY_ID_PATTERN.test(keyId)) return null;
    if (!API_KEY_SECRET_PATTERN.test(secret)) return null;
    return { keyId, secret };
  }

  /**
   * Verify a presented API key.
   * @returns {Promise<{keyId:string, tenantId:string, scopes:string[], allowedInstanceIds:string[]|null}>}
   * @throws {UnauthorizedError} for missing, malformed, unknown, revoked or expired keys
   */
  async verify(fullKey, { requestId = null, ip = null } = {}) {
    if (typeof fullKey !== 'string' || fullKey.trim() === '') {
      throw new UnauthorizedError('The X-API-Key header is required.');
    }
    const parsed = this.parseKey(fullKey);
    if (!parsed) {
      throw new UnauthorizedError('The API key is malformed.');
    }

    const record = await this.repository.findByKeyId(parsed.keyId);
    if (!record) {
      throw new UnauthorizedError('The API key is invalid.');
    }

    const presented = Buffer.from(this.hashKey(fullKey), 'utf8');
    const stored = Buffer.from(String(record.keyHash), 'utf8');
    const matches = presented.length === stored.length && crypto.timingSafeEqual(presented, stored);
    if (!matches) {
      await this.#recordFailure('api_key.verification_failed', record.tenantId, parsed.keyId, requestId, ip, 'hash_mismatch');
      throw new UnauthorizedError('The API key is invalid.');
    }

    // A revocation timestamp in the future is a rotation grace window: the
    // previous key stays valid until that instant.
    if (record.revokedAt && new Date(record.revokedAt).getTime() <= Date.now()) {
      await this.#recordFailure('api_key.verification_failed', record.tenantId, parsed.keyId, requestId, ip, 'revoked');
      throw new UnauthorizedError('The API key has been revoked.');
    }

    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      await this.#recordFailure('api_key.verification_failed', record.tenantId, parsed.keyId, requestId, ip, 'expired');
      throw new UnauthorizedError('The API key has expired.');
    }

    // Best-effort last-used tracking; never block or fail the request on it.
    this.repository
      .updateLastUsed(parsed.keyId, new Date())
      .catch((error) => this.logger?.warn({ err: error }, 'failed to update api key last-used timestamp'));

    return {
      keyId: parsed.keyId,
      tenantId: record.tenantId,
      scopes: record.scopes ?? [],
      allowedInstanceIds: record.allowedInstanceIds ?? null,
      name: record.name,
    };
  }

  async #recordFailure(action, tenantId, keyId, requestId, ip, reason) {
    await this.audit?.record({
      action,
      result: 'failure',
      tenantId,
      requestId,
      ip,
      metadata: { keyId, reason },
    });
  }

  /* ------------------------------------------------------------------ */
  /* authorisation helpers                                               */
  /* ------------------------------------------------------------------ */

  static hasScope(auth, scope) {
    if (!auth) return false;
    if (auth.scopes.includes(WILDCARD)) return true;
    return auth.scopes.includes(scope);
  }

  static assertScopes(auth, scopes) {
    const missing = scopes.filter((scope) => !ApiKeyService.hasScope(auth, scope));
    if (missing.length > 0) {
      throw new ForbiddenError('The API key is missing a required scope.', { missingScopes: missing });
    }
  }

  static assertInstanceAllowed(auth, instanceId) {
    if (!auth.allowedInstanceIds) return;
    if (!auth.allowedInstanceIds.includes(instanceId)) {
      // Deliberately a 404: never confirm the existence of another key's instance.
      throw new NotFoundError('Instance not found.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* rotation and revocation                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Rotate a key: a new secret is issued and the previous one is revoked
   * immediately. Scopes, tenant and instance allowlist are preserved.
   */
  async rotate(keyId, { tenantId, requestId = null, actorKeyId = null, actorScopes = null, ip = null, gracePeriodMs = 0 } = {}) {
    const existing = await this.repository.findByKeyId(keyId);
    if (!existing || (tenantId && existing.tenantId !== tenantId)) {
      throw new NotFoundError('API key not found.');
    }
    if (existing.revokedAt) {
      throw new ValidationError('The API key has already been revoked and cannot be rotated.', { field: 'keyId' });
    }

    const created = await this.generate({
      tenantId: existing.tenantId,
      name: existing.name,
      scopes: existing.scopes,
      expiresAt: existing.expiresAt ? new Date(existing.expiresAt).toISOString() : null,
      allowedInstanceIds: existing.allowedInstanceIds ?? null,
      createdBy: actorKeyId,
      actorScopes,
      requestId,
      ip,
    });

    // gracePeriodMs lets an operator overlap keys during a deploy; 0 = immediate.
    await this.repository.revoke(keyId, new Date(Date.now() + gracePeriodMs));

    await this.audit?.record({
      action: 'api_key.rotated',
      result: 'success',
      tenantId: existing.tenantId,
      requestId,
      actorKeyId,
      ip,
      metadata: { previousKeyId: keyId, newKeyId: created.record.keyId, gracePeriodMs },
    });

    return created;
  }

  async revoke(keyId, { tenantId, requestId = null, actorKeyId = null, ip = null } = {}) {
    const existing = await this.repository.findByKeyId(keyId);
    if (!existing || (tenantId && existing.tenantId !== tenantId)) {
      throw new NotFoundError('API key not found.');
    }
    if (existing.revokedAt) {
      return { keyId, revokedAt: existing.revokedAt, alreadyRevoked: true };
    }
    const revokedAt = new Date();
    await this.repository.revoke(keyId, revokedAt);
    await this.audit?.record({
      action: 'api_key.revoked',
      result: 'success',
      tenantId: existing.tenantId,
      requestId,
      actorKeyId,
      ip,
      metadata: { keyId },
    });
    return { keyId, revokedAt, alreadyRevoked: false };
  }

  async list(tenantId, { limit = 50, offset = 0 } = {}) {
    return this.repository.listByTenant(tenantId, { limit, offset });
  }

  async getOwn(auth, keyId) {
    const record = await this.repository.findByKeyId(keyId);
    if (!record || record.tenantId !== auth.tenantId) throw new NotFoundError('API key not found.');
    return record;
  }
}

export function publicApiKeyView(record) {
  return {
    id: record.id,
    keyId: record.keyId,
    tenantId: record.tenantId,
    name: record.name,
    scopes: record.scopes,
    allowedInstanceIds: record.allowedInstanceIds ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    // keyHash is intentionally never exposed.
  };
}
