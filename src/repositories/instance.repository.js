/**
 * Instance repository (file-backed).
 *
 * Each instance lives in its own directory: `data/instances/<instance-id>/`.
 * Tenant isolation is still enforced by the service layer, and directory names
 * are derived from validated instance ids only, so a crafted id can never point
 * outside the store.
 */
import { pageDesc, reviveDates, toMillis } from './support.js';

const DATE_FIELDS = ['createdAt', 'updatedAt', 'lastConnectedAt'];
const INSTANCE_ID_PATTERN = /^ins_[a-f0-9]{32}$/;

function isSafeId(id) {
  return typeof id === 'string' && INSTANCE_ID_PATTERN.test(id);
}

function toInstance(row) {
  return reviveDates({ ...row }, DATE_FIELDS);
}

export function createInstanceRepository({ store }) {
  const paths = store.paths;

  async function readOne(id) {
    if (!isSafeId(id)) return null;
    const row = await store.readJson(paths.instanceFile(id), { fallback: null });
    return row && typeof row === 'object' ? toInstance(row) : null;
  }

  async function readAll() {
    const entries = await store.listDir(paths.instancesDir);
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const row = await readOne(entry.name);
      if (row) rows.push(row);
    }
    return rows;
  }

  return {
    async create(record) {
      await store.ensureDir(paths.instanceDir(record.id));
      await store.writeJson(paths.instanceFile(record.id), record);
      return toInstance(record);
    },

    async findById(id) {
      return readOne(id);
    },

    async listByTenant(tenantId, { limit = 25, cursor = null } = {}) {
      const rows = (await readAll()).filter((instance) => instance.tenantId === tenantId);
      return pageDesc(rows, { limit, cursor }, (instance) => ({
        t: toMillis(instance.createdAt),
        i: instance.id,
      }));
    },

    async update(id, patch) {
      const existing = await readOne(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      await store.writeJson(paths.instanceFile(id), updated);
      return toInstance(updated);
    },

    async delete(id) {
      const existing = await readOne(id);
      if (!existing) return null;
      await store.removeDir(paths.instanceDir(id));
      return toInstance(existing);
    },

    async listAll() {
      return readAll();
    },

    async reset() {
      await store.removeDir(paths.instancesDir);
      await store.ensureDir(paths.instancesDir);
    },
  };
}
