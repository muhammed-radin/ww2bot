/**
 * Encrypted session archive repository (file-backed).
 *
 * The archive is written as an opaque AES-256-GCM ciphertext token in
 * `data/instances/<id>/session-archive.enc`; only non-secret metadata (strategy,
 * key id, timestamp) goes in a companion JSON file. The encryption key never
 * lives next to the data.
 */
export function createSessionRepository({ store }) {
  const paths = store.paths;

  return {
    async upsert({ instanceId, ciphertext, keyId, strategy, updatedAt }) {
      await store.writeText(paths.sessionArchiveFile(instanceId), ciphertext);
      await store.writeJson(paths.sessionArchiveMetaFile(instanceId), { keyId, strategy, updatedAt });
      return { instanceId, keyId, strategy, updatedAt };
    },

    async get(instanceId) {
      const ciphertext = await store.readText(paths.sessionArchiveFile(instanceId));
      if (!ciphertext) return null;
      const meta = await store.readJson(paths.sessionArchiveMetaFile(instanceId), { fallback: {} });
      return {
        instanceId,
        ciphertext,
        keyId: meta?.keyId ?? null,
        strategy: meta?.strategy ?? null,
        updatedAt: meta?.updatedAt ? new Date(meta.updatedAt) : null,
      };
    },

    async list(instanceIds = null) {
      const ids = instanceIds ?? (await instanceDirectories(store));
      const out = [];
      for (const id of ids) {
        const record = await this.get(id);
        if (record) out.push({ instanceId: id, keyId: record.keyId, strategy: record.strategy, updatedAt: record.updatedAt });
      }
      return out;
    },

    async delete(instanceId) {
      const existed = await store.exists(paths.sessionArchiveFile(instanceId));
      await store.removeFile(paths.sessionArchiveFile(instanceId));
      await store.removeFile(paths.sessionArchiveMetaFile(instanceId));
      return existed ? 1 : 0;
    },

    async reset() {
      for (const id of await instanceDirectories(store)) {
        await this.delete(id);
      }
    },
  };
}

async function instanceDirectories(store) {
  const entries = await store.listDir(store.paths.instancesDir);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
