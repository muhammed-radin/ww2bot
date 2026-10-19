/**
 * API key repository (file-backed).
 *
 * Keys are stored in `data/api-keys/keys.json`. Only the metadata and the
 * pepper-keyed digest are persisted — never the plaintext key. The whole file is
 * rewritten atomically on each mutation and updates to it are serialised, so two
 * concurrent requests cannot lose a change.
 */
import { reviveDates, toMillis } from './support.js';

const DATE_FIELDS = ['createdAt', 'expiresAt', 'revokedAt', 'lastUsedAt'];
const MAX_KEYS = 5000;

function normalise(data) {
  const keys =
    data && typeof data === 'object' && data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys)
      ? data.keys
      : {};
  return { version: 1, keys: { ...keys } };
}

function validate(data) {
  return Boolean(data) && typeof data === 'object' && data.keys !== null && typeof data.keys === 'object' && !Array.isArray(data.keys);
}

function toRecord(row) {
  return reviveDates({ ...row }, DATE_FIELDS);
}

export function createApiKeyRepository({ store }) {
  const file = store.paths.apiKeysFile;
  const options = { fallback: { version: 1, keys: {} }, validate };

  const readAll = async () => normalise(await store.readJson(file, options));

  return {
    async create(record) {
      let saved = null;
      await store.updateJson(
        file,
        (data) => {
          const current = normalise(data);
          if (!current.keys[record.keyId] && Object.keys(current.keys).length >= MAX_KEYS) {
            throw new Error('The API key store has reached its maximum number of keys.');
          }
          current.keys[record.keyId] = { ...record };
          saved = current.keys[record.keyId];
          return current;
        },
        options,
      );
      return saved ? toRecord(saved) : toRecord(record);
    },

    async findByKeyId(keyId) {
      const data = await readAll();
      const row = data.keys[keyId];
      return row ? toRecord(row) : null;
    },

    async updateLastUsed(keyId, at) {
      await store.updateJson(
        file,
        (data) => {
          const current = normalise(data);
          const row = current.keys[keyId];
          if (!row) return undefined;
          row.lastUsedAt = at;
          return current;
        },
        options,
      );
    },

    async revoke(keyId, at) {
      let revoked = null;
      await store.updateJson(
        file,
        (data) => {
          const current = normalise(data);
          const row = current.keys[keyId];
          if (!row || row.revokedAt) return undefined;
          row.revokedAt = at;
          revoked = row;
          return current;
        },
        options,
      );
      return revoked ? toRecord(revoked) : null;
    },

    async listByTenant(tenantId, { limit = 50, offset = 0 } = {}) {
      const data = await readAll();
      return Object.values(data.keys)
        .filter((row) => row.tenantId === tenantId)
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
        .slice(offset, offset + limit)
        .map(toRecord);
    },

    async deleteExpired(before) {
      const cutoff = toMillis(before);
      let removed = 0;
      await store.updateJson(
        file,
        (data) => {
          const current = normalise(data);
          for (const [keyId, row] of Object.entries(current.keys)) {
            if (row.revokedAt && row.expiresAt && toMillis(row.expiresAt) < cutoff) {
              delete current.keys[keyId];
              removed += 1;
            }
          }
          return removed > 0 ? current : undefined;
        },
        options,
      );
      return removed;
    },

    async reset() {
      await store.removeFile(file);
    },
  };
}
