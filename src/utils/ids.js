/**
 * Identifier generation.
 *
 * Instance and API-key identifiers are derived from a CSPRNG so they cannot be
 * enumerated or guessed. IDs are prefixed for readability only; the entropy is
 * in the random bytes.
 */
import crypto from 'node:crypto';

/** 128 bits of randomness, hex encoded. */
export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function newInstanceId() {
  return `ins_${randomHex(16)}`;
}

export function newApiKeyId() {
  // 72 bits: short enough to search by, large enough to avoid collisions.
  return crypto.randomBytes(9).toString('hex');
}

export function newAuditEventId() {
  return `evt_${randomHex(12)}`;
}

export function newRequestId() {
  return `req_${randomHex(12)}`;
}

export function newSessionTokenId() {
  return `stk_${randomHex(16)}`;
}

export function newUuid() {
  return crypto.randomUUID();
}
