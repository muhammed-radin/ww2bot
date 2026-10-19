/**
 * Audit trail and webhook de-duplication (file-backed).
 *
 * Audit events are appended to `data/audit/events.jsonl`. The provider-event
 * dedupe markers live next to their instance in
 * `data/instances/<id>/webhook-events.jsonl`, so deleting an instance removes
 * its markers with it.
 *
 * The append and the read-modify-write both take the same per-file mutex, so a
 * maintenance purge can never race an in-flight append and lose an event.
 */
import { reviveDates, toMillis } from './support.js';

const AUDIT_DATE_FIELDS = ['createdAt'];
const MAX_LIST = 1000;

export function createAuditRepository({ store }) {
  const file = store.paths.auditFile;

  return {
    async create(event) {
      await store.appendJsonl(file, reviveDates({ ...event }, AUDIT_DATE_FIELDS));
      return reviveDates({ ...event }, AUDIT_DATE_FIELDS);
    },

    async list({ tenantId, instanceId = null, limit = 100, offset = 0 }) {
      const rows = await store.readJsonl(file);
      return rows
        .filter((event) => event.tenantId === tenantId && (!instanceId || event.instanceId === instanceId))
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
        .slice(offset, offset + Math.min(limit, MAX_LIST))
        .map((event) => reviveDates({ ...event }, AUDIT_DATE_FIELDS));
    },

    async count({ tenantId, instanceId = null }) {
      const rows = await store.readJsonl(file);
      return rows.filter((event) => event.tenantId === tenantId && (!instanceId || event.instanceId === instanceId)).length;
    },

    async deleteOlderThan(cutoff) {
      const before = toMillis(cutoff);
      let removed = 0;
      await store.updateJsonl(file, (rows) => {
        const kept = rows.filter((event) => {
          if (toMillis(event.createdAt) < before) {
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
      let removed = 0;
      await store.updateJsonl(file, (rows) => {
        const kept = rows.filter((event) => {
          if (event.instanceId === instanceId) {
            removed += 1;
            return false;
          }
          return true;
        });
        return removed > 0 ? kept : undefined;
      });
      return removed;
    },

    async reset() {
      await store.removeFile(file);
    },
  };
}

export function createWebhookEventRepository({ store }) {
  const paths = store.paths;
  const fileFor = (instanceId) => paths.webhookEventsFile(instanceId);

  async function listInstanceFiles() {
    const entries = await store.listDir(paths.instancesDir);
    return entries
      .filter((entry) => entry.isDirectory() && /^ins_[a-f0-9]{32}$/.test(entry.name))
      .map((entry) => entry.name);
  }

  return {
    async recordIfNew({ providerEventId, instanceId, eventType, receivedAt }) {
      let isDuplicate = false;
      await store.updateJsonl(fileFor(instanceId), (rows) => {
        if (rows.some((row) => row.providerEventId === providerEventId)) {
          isDuplicate = true;
          return undefined;
        }
        return [...rows, { providerEventId, instanceId, eventType, receivedAt }];
      });
      return { isDuplicate };
    },

    async list({ instanceId = null, limit = 100, offset = 0 } = {}) {
      const ids = instanceId ? [instanceId] : await listInstanceFiles();
      const rows = [];
      for (const id of ids) {
        rows.push(...(await store.readJsonl(fileFor(id))));
      }
      return rows
        .sort((a, b) => toMillis(b.receivedAt) - toMillis(a.receivedAt))
        .slice(offset, offset + Math.min(limit, MAX_LIST))
        .map((row) => ({ ...row }));
    },

    async deleteOlderThan(cutoff) {
      const before = toMillis(cutoff);
      let removed = 0;
      for (const id of await listInstanceFiles()) {
        await store.updateJsonl(fileFor(id), (rows) => {
          const kept = rows.filter((row) => {
            if (toMillis(row.receivedAt) < before) {
              removed += 1;
              return false;
            }
            return true;
          });
          return removed > 0 ? kept : undefined;
        });
      }
      return removed;
    },

    async deleteByInstance(instanceId) {
      const rows = await store.readJsonl(fileFor(instanceId));
      if (rows.length === 0) return 0;
      await store.removeFile(fileFor(instanceId));
      return rows.length;
    },

    async reset() {
      for (const id of await listInstanceFiles()) {
        await store.removeFile(fileFor(id));
      }
    },
  };
}
