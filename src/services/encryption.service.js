/**
 * Authenticated encryption at rest (AES-256-GCM) with a key ring.
 *
 * Format: ENC:v1:<keyId>:<iv base64url>:<tag base64url>:<ciphertext base64url>
 *
 * Design notes:
 *  - Every ciphertext records the key id used to create it, so keys can be
 *    rotated without losing the ability to read existing data.
 *  - GCM gives confidentiality *and* integrity: a modified ciphertext fails to
 *    decrypt rather than returning attacker-controlled plaintext.
 *  - Optional additional authenticated data (AAD) binds a ciphertext to its
 *    logical location (for example an instance id), preventing cut-and-paste of
 *    one instance's ciphertext into another instance's row.
 *  - This is encryption of data the gateway legitimately handles. It is NOT,
 *    and must never be described as, end-to-end encryption of WhatsApp traffic.
 */
import crypto from 'node:crypto';
import { AppError, ErrorCode } from '../utils/errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'ENC';
const VERSION = 'v1';
const MAX_CIPHERTEXT_BYTES = 32 * 1024 * 1024; // 32 MiB hard ceiling
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class EncryptionError extends AppError {
  constructor(message, details) {
    super(ErrorCode.INTERNAL_ERROR, message, { status: 500, details });
  }
}

export class EncryptionService {
  /**
   * @param {{keys: Record<string,string>, activeKeyId: string, logger?: object}} options
   */
  constructor({ keys, activeKeyId, logger }) {
    if (!keys || Object.keys(keys).length === 0) {
      throw new EncryptionError('No encryption keys are configured.');
    }
    if (!keys[activeKeyId]) {
      throw new EncryptionError('The active encryption key id is not present in the key ring.');
    }
    this.logger = logger;
    this.activeKeyId = activeKeyId;
    this.keys = new Map();
    for (const [keyId, base64Key] of Object.entries(keys)) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new EncryptionError('Encryption key ids may only contain letters, digits, "_" and "-".');
      }
      const key = Buffer.from(base64Key, 'base64');
      if (key.length !== 32) {
        throw new EncryptionError('Encryption keys must decode to exactly 32 bytes.');
      }
      this.keys.set(keyId, key);
    }
    // Derived subkeys keep hashing/redaction helpers independent of the AEAD key.
    this._deriveKey = (purpose, keyId = this.activeKeyId) =>
      crypto.hkdfSync('sha256', this.keys.get(keyId), Buffer.alloc(0), `wa-gateway:${purpose}`, 32);
  }

  get activeKeyIdValue() {
    return this.activeKeyId;
  }

  keyIds() {
    return [...this.keys.keys()];
  }

  /**
   * Encrypt a UTF-8 string or Buffer.
   * @param {string|Buffer} plaintext
   * @param {{aad?: string}} [options]
   * @returns {string} versioned ciphertext token
   */
  encrypt(plaintext, { aad } = {}) {
    if (plaintext === undefined || plaintext === null) {
      throw new EncryptionError('Cannot encrypt an empty value.');
    }
    const keyId = this.activeKeyId;
    const key = this.keys.get(keyId);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, VERSION, keyId, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
      ':',
    );
  }

  /**
   * Decrypt a token produced by {@link encrypt}.
   * @param {string} token
   * @param {{aad?: string}} [options]
   * @returns {Buffer}
   */
  decryptBuffer(token, { aad } = {}) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new EncryptionError('Cannot decrypt an empty value.');
    }
    if (token.length > MAX_CIPHERTEXT_BYTES) {
      throw new EncryptionError('The ciphertext exceeds the supported size.');
    }
    const parts = token.split(':');
    if (parts.length !== 6 || parts[0] !== PREFIX) {
      throw new EncryptionError('The ciphertext is malformed.');
    }
    const [, version, keyId, ivPart, tagPart, ctPart] = parts;
    if (version !== VERSION) {
      throw new EncryptionError('The ciphertext version is not supported.');
    }
    const key = this.keys.get(keyId);
    if (!key) {
      throw new EncryptionError('The ciphertext was created with an unknown encryption key.', { keyId });
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ctPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new EncryptionError('The ciphertext is malformed.');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw new EncryptionError('The ciphertext failed its integrity check.', { cause: error });
    }
  }

  decrypt(token, options) {
    return this.decryptBuffer(token, options).toString('utf8');
  }

  /** Re-encrypt an existing token with the active key (key rotation). */
  rewrap(token, { aad } = {}) {
    const plaintext = this.decryptBuffer(token, { aad });
    return this.encrypt(plaintext, { aad });
  }

  /** True when a token was produced by the currently active key. */
  isCurrentKey(token) {
    if (typeof token !== 'string') return false;
    const parts = token.split(':');
    return parts.length === 6 && parts[2] === this.activeKeyId;
  }

  /**
   * Deterministic keyed digest, used where a stable opaque value is needed
   * (webhook dedupe keys, session fingerprints). Not reversible.
   */
  keyedDigest(value, { purpose = 'digest' } = {}) {
    const key = this._deriveKey(purpose);
    return crypto.createHmac('sha256', Buffer.from(key)).update(String(value), 'utf8').digest('hex');
  }
}

export function createEncryptionService(config, logger) {
  return new EncryptionService({
    keys: config.encryption.keys,
    activeKeyId: config.encryption.activeKeyId,
    logger,
  });
}
