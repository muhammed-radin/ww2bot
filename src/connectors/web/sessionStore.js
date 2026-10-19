/**
 * Encrypted session store for whatsapp-web.js RemoteAuth.
 *
 * The library's RemoteAuth strategy hands this store a zip archive of the
 * browser profile. We encrypt that archive with AES-256-GCM (keyed by the
 * gateway's key ring, never stored next to the data) and persist only the
 * ciphertext. Extraction decrypts to a private temp path owned by the browser
 * process.
 *
 * Interface matches `whatsapp-web.js` Store:
 *   save({ session, path })   persist the archive that lives at `path`
 *   extract({ session, path }) write the archive back to `path`
 *   delete({ session })       remove stored material
 *
 * Verified against whatsapp-web.js v1.34.x (RemoteAuth passes the session name,
 * not a filesystem path, to these methods).
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { AppError, ErrorCode } from '../../utils/errors.js';

export function createEncryptedSessionStore({ sessionService, instance, logger }) {
  function assertSession(session) {
    if (session !== instance.id) {
      // Defensive: a session name mismatch would risk writing one instance's
      // profile under another instance's key.
      throw new AppError(ErrorCode.FORBIDDEN, 'Session name does not match the instance bound to this store.', {
        status: 403,
      });
    }
  }

  return {
    async save({ session, path }) {
      assertSession(session);
      const buffer = await fs.readFile(path);
      await sessionService.persistEncryptedArchive(instance, buffer, { strategy: 'remote_encrypted' });
      logger?.debug({ instanceId: instance.id, bytes: buffer.length }, 'encrypted session archive persisted');
      return true;
    },

    async extract({ session, path }) {
      assertSession(session);
      const buffer = await sessionService.loadEncryptedArchive(instance);
      if (!buffer) {
        throw new AppError(ErrorCode.NOT_FOUND, 'No stored session archive exists for this instance.', { status: 404 });
      }
      await fs.mkdir(nodePath.dirname(path), { recursive: true }).catch(() => {});
      await fs.writeFile(path, buffer, { mode: 0o600 });
      logger?.debug({ instanceId: instance.id, bytes: buffer.length }, 'encrypted session archive extracted');
      return true;
    },

    async delete({ session }) {
      assertSession(session);
      await sessionService.destroySession(instance, { reason: 'remote_store_delete' });
      return true;
    },

    async sessionExists({ session }) {
      assertSession(session);
      const record = await sessionService.repository.get(instance.id);
      return Boolean(record);
    },
  };
}
