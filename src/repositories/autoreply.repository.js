/**
 * Automatic-reply rule repository (file-backed).
 *
 * Rules are per-instance plain configuration (a literal match and a reply
 * body), stored in `data/instances/<id>/autoreplies.json`. They contain no
 * credentials and no message content: only what the operator typed as a rule.
 */
import { randomHex } from '../utils/ids.js';

const INSTANCE_ID_PATTERN = /^ins_[a-f0-9]{32}$/;

function normaliseRule(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    name: row.name ?? null,
    enabled: row.enabled !== false,
    match: row.match ?? { type: 'exact', value: '', caseSensitive: false },
    reply: row.reply ?? { text: '' },
    cooldownSeconds:
      Number.isInteger(row.cooldownSeconds) && row.cooldownSeconds >= 0 ? row.cooldownSeconds : 0,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    stats: row.stats ?? { matches: 0, replies: 0, failures: 0, lastMatchedAt: null, lastError: null },
  };
}

export function createAutoReplyRepository({ store, logger = null }) {
  const paths = store.paths;
  const fileFor = (instanceId) => paths.autorepliesFile(instanceId);

  return {
    async list(instanceId) {
      if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) return [];
      const rows = await store.readJson(fileFor(instanceId), { fallback: [] });
      return Array.isArray(rows) ? rows.map(normaliseRule).filter(Boolean) : [];
    },

    async get(instanceId, ruleId) {
      const rules = await this.list(instanceId);
      return rules.find((rule) => rule.id === ruleId) ?? null;
    },

    async create(instanceId, rule) {
      const now = new Date().toISOString();
      const record = normaliseRule({
        ...rule,
        id: `arr_${randomHex(12)}`,
        createdAt: now,
        updatedAt: now,
      });
      await store.updateJson(
        fileFor(instanceId),
        (current) => [...(Array.isArray(current) ? current : []), record],
        { fallback: [] },
      );
      return record;
    },

    async update(instanceId, ruleId, patch) {
      let updated = null;
      await store.updateJson(
        fileFor(instanceId),
        (current) => {
          const rows = Array.isArray(current) ? current : [];
          const index = rows.findIndex((row) => row.id === ruleId);
          if (index === -1) return undefined;
          updated = normaliseRule({ ...rows[index], ...patch, id: ruleId, updatedAt: new Date().toISOString() });
          const next = [...rows];
          next[index] = updated;
          return next;
        },
        { fallback: [] },
      );
      return updated;
    },

    async remove(instanceId, ruleId) {
      let removed = false;
      await store.updateJson(
        fileFor(instanceId),
        (current) => {
          const rows = Array.isArray(current) ? current : [];
          const next = rows.filter((row) => row.id !== ruleId);
          if (next.length === rows.length) return undefined;
          removed = true;
          return next;
        },
        { fallback: [] },
      );
      return removed;
    },

    async recordOutcome(instanceId, ruleId, { matched = false, replied = false, error = null } = {}) {
      try {
        await store.updateJson(
          fileFor(instanceId),
          (current) => {
            const rows = Array.isArray(current) ? current : [];
            const index = rows.findIndex((row) => row.id === ruleId);
            if (index === -1) return undefined;
            const rule = normaliseRule(rows[index]);
            const stats = {
              ...rule.stats,
              matches: rule.stats.matches + (matched ? 1 : 0),
              replies: rule.stats.replies + (replied ? 1 : 0),
              failures: rule.stats.failures + (error ? 1 : 0),
              lastMatchedAt: matched ? new Date().toISOString() : rule.stats.lastMatchedAt,
              lastError: error ? String(error).slice(0, 200) : rule.stats.lastError,
            };
            const next = [...rows];
            next[index] = { ...rule, stats, updatedAt: new Date().toISOString() };
            return next;
          },
          { fallback: [] },
        );
      } catch (err) {
        // Statistics are best-effort; never fail a reply because bookkeeping did.
        logger?.warn({ err, instanceId, ruleId }, 'failed to record auto-reply outcome');
      }
    },

    async deleteByInstance(instanceId) {
      const rows = await this.list(instanceId);
      if (rows.length > 0) await store.removeFile(fileFor(instanceId));
      return rows.length;
    },

    async reset() {
      const entries = await store.listDir(paths.instancesDir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await store.removeFile(paths.autorepliesFile(entry.name)).catch(() => {});
      }
    },
  };
}
