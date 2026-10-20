/**
 * Delivery metadata repository (file-backed).
 *
 * The gateway stores the minimum needed to (a) make outbound sends idempotent
 * across retries and (b) troubleshoot a failed send. Recipients are encrypted
 * at rest; the idempotency key is only ever stored as a keyed digest.
 *
 * Records are bounded by `DELIVERY_METADATA_RETENTION_DAYS` and removed with
 * their instance.
 */
import { toMillis } from './support.js';

const INSTANCE_ID_PATTERN = /^ins_[a-f0-9]{32}$/;
const ENC_PREFIX = 'ENC:';

export function createDeliveryRepository({ store, encryption, logger = null }) {
  const paths = store.paths;
  const fileFor = (instanceId) => paths.deliveriesFile(instanceId);

  const aadFor = (instanceId, id) => `delivery:${instanceId}:${id}`;

  function sealRecipient(instanceId, row) {
    if (!row.recipient) return null;
    if (!encryption) return String(row.recipient);
    return encryption.encrypt(String(row.recipient), { aad: aadFor(instanceId, row.id) });
  }

  function openRecipient(instanceId, row) {
    if (typeof row.recipient !== 'string' || row.recipient === '') return null;
    if (!row.recipient.startsWith(ENC_PREFIX) || !encryption) return row.recipient;
    try {
      return encryption.decrypt(row.recipient, { aad: aadFor(instanceId, row.id) });
    } catch {
      logger?.warn({ instanceId, deliveryId: row.id }, 'failed to decrypt a delivery recipient');
      return null;
    }
  }

  const decorate = (instanceId, row) => ({ ...row, recipient: openRecipient(instanceId, row) });

  return {
    /** Record a send. Returns the stored record (existing one on a duplicate key). */
    async record(record) {
      let stored = null;
      await store.updateJsonl(fileFor(record.instanceId), (rows) => {
        // Only an actual idempotency key may collapse records. Keyless sends
        // all share a null digest; treating that as a duplicate would return
        // the first keyless delivery (and its provider id) forever.
        const existing = record.idempotencyKeyHash
          ? rows.find((row) => row.idempotencyKeyHash === record.idempotencyKeyHash)
          : null;
        if (existing) {
          stored = existing;
          return undefined;
        }
        const row = { ...record };
        row.recipient = sealRecipient(record.instanceId, row);
        stored = row;
        return [...rows, row];
      });
      return decorate(record.instanceId, stored);
    },

    async findByIdempotency(instanceId, idempotencyKeyHash) {
      if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) return null;
      const rows = await store.readJsonl(fileFor(instanceId));
      const row = rows.find((candidate) => candidate.idempotencyKeyHash === idempotencyKeyHash);
      return row ? decorate(instanceId, row) : null;
    },

    async list(instanceId, { limit = 50 } = {}) {
      if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) return [];
      const rows = await store.readJsonl(fileFor(instanceId));
      return rows
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
        .slice(0, limit)
        .map((row) => decorate(instanceId, row));
    },

    async purgeBefore(instanceId, cutoff) {
      const before = toMillis(cutoff);
      let removed = 0;
      await store.updateJsonl(fileFor(instanceId), (rows) => {
        const kept = rows.filter((row) => {
          if (toMillis(row.createdAt) < before) {
            removed += 1;
            return false;
          }
          return true;
        });
        return removed > 0 ? kept : undefined;
      });
      return removed;
    },

    async deleteByInstance(instanceId) {
      const rows = await store.readJsonl(fileFor(instanceId));
      if (rows.length > 0) await store.removeFile(fileFor(instanceId));
      return rows.length;
    },

    async reset() {
      const entries = await store.listDir(paths.instancesDir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await store.removeFile(paths.deliveriesFile(entry.name)).catch(() => {});
      }
    },
  };
}
