/**
 * Session storage security.
 *
 * Two storage strategies exist for the authorised WhatsApp Web connector:
 *
 *  1. "local" (whatsapp-web.js LocalAuth)
 *     A Chromium profile directory on disk. The gateway creates it with 0700
 *     permissions inside a per-instance, per-tenant directory, but the contents
 *     are NOT encrypted by this service. Encrypting at rest is therefore the
 *     responsibility of the hosting volume (encrypted EBS/GCE PD/Ceph, LUKS,
 *     ...). The README states this explicitly; the gateway never claims
 *     otherwise.
 *
 *  2. "remote_encrypted" (whatsapp-web.js RemoteAuth + EncryptedSessionStore)
 *     Session archives are encrypted with AES-256-GCM before they are written
 *     to disk, so no plaintext session material is persisted.
 *
 * Both strategies give every instance its own directory under
 * `data/instances/<instance-id>/session`; cookies, IndexedDB and authentication
 * material are never shared between instances and are never returned through the
 * API.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, ErrorCode } from '../utils/errors.js';

export class SessionService {
  constructor({ config, encryption, repository, logger, audit, paths }) {
    this.config = config;
    this.encryption = encryption;
    this.repository = repository;
    this.logger = logger;
    this.audit = audit;
    this.paths = paths;
    this.root = paths ? paths.instancesDir : path.resolve('./data/instances');
  }

  /** Directory for one instance: `data/instances/<instance-id>/session`. */
  instanceDirectory(instance) {
    if (!this.paths) throw new AppError(ErrorCode.INTERNAL_ERROR, 'Session storage paths are not configured.', { status: 500 });
    return this.paths.browserProfileDir(instance.id);
  }

  /** Create the instance directory with restrictive permissions. */
  async ensureInstanceDirectory(instance) {
    const directory = this.instanceDirectory(instance);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(this.root, instance.id), 0o700).catch(() => {});
    await fs.chmod(directory, 0o700).catch(() => {});
    return directory;
  }

  async directoryExists(instance) {
    try {
      const stats = await fs.stat(this.instanceDirectory(instance));
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async removeInstanceDirectory(instance) {
    const directory = this.instanceDirectory(instance);
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
      return true;
    } catch (error) {
      this.logger?.error({ err: error, instanceId: instance.id }, 'failed to remove session directory');
      return false;
    }
  }

  /** Persist an encrypted session archive (remote_encrypted strategy). */
  async persistEncryptedArchive(instance, buffer, { strategy = 'remote_encrypted' } = {}) {
    const plaintext = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
    const ciphertext = this.encryption.encrypt(plaintext, { aad: `session:${instance.id}` });
    const saved = await this.repository.upsert({
      instanceId: instance.id,
      ciphertext,
      keyId: this.encryption.activeKeyIdValue,
      strategy,
      updatedAt: new Date(),
    });
    await this.audit?.record({
      action: 'session.persisted',
      result: 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      metadata: { strategy, bytes: plaintext.length },
    });
    return saved;
  }

  /** Load and decrypt a session archive, or null when none exists. */
  async loadEncryptedArchive(instance) {
    const record = await this.repository.get(instance.id);
    if (!record) return null;
    return this.encryption.decryptBuffer(record.ciphertext, { aad: `session:${instance.id}` });
  }

  /**
   * Remove every trace of an instance's authentication material:
   * browser profile directory plus any encrypted archive on disk.
   */
  async destroySession(instance, { reason = 'logout' } = {}) {
    const directoryRemoved = await this.removeInstanceDirectory(instance);
    const archiveRemoved = (await this.repository.delete(instance.id)) > 0;
    await this.audit?.record({
      action: 'session.destroyed',
      result: 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      metadata: { reason, directoryRemoved, archiveRemoved },
    });
    return { directoryRemoved, archiveRemoved };
  }

  /** Non-sensitive session metadata for the API (never returns ciphertext). */
  async describe(instance) {
    const record = await this.repository.get(instance.id);
    const directoryExists = await this.directoryExists(instance);
    return {
      encryptedArchive: record
        ? { present: true, keyId: record.keyId, strategy: record.strategy, updatedAt: record.updatedAt }
        : { present: false },
      browserProfileDirectory: directoryExists,
      // Storage caveat is reported to the caller instead of being hidden.
      atRestEncryption:
        record
          ? 'encrypted (AES-256-GCM) for the session archive; browser profile directory depends on the configured strategy'
          : directoryExists
            ? 'not encrypted by this service: browser profile directory relies on volume-level encryption'
            : 'no session material stored',
    };
  }
}
