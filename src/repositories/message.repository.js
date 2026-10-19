/**
 * Retained message repository (file-backed).
 *
 * Messages are only ever written when the operator explicitly opts in to
 * retention for the instance. Message bodies are encrypted with AES-256-GCM
 * before they touch disk, with the instance id and message id bound as
 * additional authenticated data so a ciphertext cannot be copied between rows.
 *
 * Chat/message grouping and pagination happen in memory over the parsed JSONL
 * rows; retained volumes are bounded by the configured retention window.
 */
import { pageDesc, reviveDates, toMillis } from './support.js';

const DATE_FIELDS = ['sentAt', 'createdAt'];
const ENC_PREFIX = 'ENC:';

function toMessage(row) {
  return reviveDates({ ...row }, DATE_FIELDS);
}

export function createMessageRepository({ store, encryption, logger = null }) {
  const paths = store.paths;
  const fileFor = (instanceId) => paths.messagesFile(instanceId);

  function sealBody(instanceId, row) {
    if (row.body === null || row.body === undefined || row.body === '') return null;
    if (!encryption) return String(row.body);
    return encryption.encrypt(String(row.body), { aad: `msg:${instanceId}:${row.id}` });
  }

  function openBody(instanceId, row) {
    if (typeof row.body !== 'string' || row.body === '') return null;
    if (!row.body.startsWith(ENC_PREFIX) || !encryption) return row.body;
    try {
      return encryption.decrypt(row.body, { aad: `msg:${instanceId}:${row.id}` });
    } catch {
      logger?.warn({ instanceId, messageId: row.id }, 'failed to decrypt a retained message body');
      return null;
    }
  }

  async function rowsFor(instanceId, tenantId) {
    if (!instanceId || !tenantId) return [];
    const rows = await store.readJsonl(fileFor(instanceId));
    return rows.filter((row) => row.instanceId === instanceId && row.tenantId === tenantId);
  }

  return {
    async upsertMany(instanceId, tenantId, messages) {
      let inserted = 0;
      await store.updateJsonl(fileFor(instanceId), (rows) => {
        const seen = new Set(rows.map((row) => row.providerMessageId));
        const next = [...rows];
        for (const message of messages) {
          if (!message.providerMessageId || seen.has(message.providerMessageId)) continue;
          seen.add(message.providerMessageId);
          const row = {
            ...message,
            instanceId,
            tenantId,
            createdAt: message.createdAt ?? new Date(),
          };
          row.body = sealBody(instanceId, row);
          next.push(row);
          inserted += 1;
        }
        return inserted > 0 ? next : undefined;
      });
      return inserted;
    },

    async listChats(instanceId, tenantId, { limit = 25, cursor = null, since = null, until = null } = {}) {
      const rows = await rowsFor(instanceId, tenantId);
      const grouped = new Map();
      for (const row of rows) {
        const time = toMillis(row.sentAt);
        if (since !== null && since !== undefined && time < toMillis(since)) continue;
        if (until !== null && until !== undefined && time > toMillis(until)) continue;
        const existing = grouped.get(row.chatId);
        if (!existing) {
          grouped.set(row.chatId, { chatId: row.chatId, lastMessageAt: row.sentAt, lastMillis: time, messageCount: 1 });
        } else {
          existing.messageCount += 1;
          if (time > existing.lastMillis) {
            existing.lastMillis = time;
            existing.lastMessageAt = row.sentAt;
          }
        }
      }
      const { items, hasMore } = pageDesc([...grouped.values()], { limit, cursor }, (chat) => ({
        t: toMillis(chat.lastMessageAt),
        i: chat.chatId,
      }));
      return {
        items: items.map((chat) => ({
          chatId: chat.chatId,
          lastMessageAt: chat.lastMessageAt,
          messageCount: chat.messageCount,
        })),
        hasMore,
      };
    },

    async getChat(instanceId, tenantId, chatId) {
      const rows = (await rowsFor(instanceId, tenantId)).filter((row) => row.chatId === chatId);
      if (rows.length === 0) return null;
      const latest = rows.reduce((acc, row) => (toMillis(row.sentAt) > toMillis(acc.sentAt) ? row : acc), rows[0]);
      return { chatId, lastMessageAt: latest.sentAt, messageCount: rows.length };
    },

    async listMessages(instanceId, tenantId, chatId, { limit = 25, cursor = null, since = null, until = null } = {}) {
      const rows = (await rowsFor(instanceId, tenantId)).filter((row) => {
        if (row.chatId !== chatId) return false;
        const time = toMillis(row.sentAt);
        if (since !== null && since !== undefined && time < toMillis(since)) return false;
        if (until !== null && until !== undefined && time > toMillis(until)) return false;
        return true;
      });
      const page = pageDesc(rows, { limit, cursor }, (row) => ({ t: toMillis(row.sentAt), i: row.id }));
      return {
        ...page,
        items: page.items.map((row) => {
          const message = toMessage(row);
          message.body = openBody(instanceId, row);
          return message;
        }),
      };
    },

    /**
     * Every stored message for an instance, newest first, with optional chat,
     * direction and date filters. Backs the instance-wide message history and
     * the live feed's snapshot.
     */
    async listRecent(instanceId, tenantId, { limit = 25, cursor = null, chatId = null, direction = null, since = null, until = null } = {}) {
      const rows = (await rowsFor(instanceId, tenantId)).filter((row) => {
        if (chatId && row.chatId !== chatId) return false;
        if (direction && row.direction !== direction) return false;
        const time = toMillis(row.sentAt);
        if (since !== null && since !== undefined && time < toMillis(since)) return false;
        if (until !== null && until !== undefined && time > toMillis(until)) return false;
        return true;
      });
      const page = pageDesc(rows, { limit, cursor }, (row) => ({ t: toMillis(row.sentAt), i: row.id }));
      return {
        ...page,
        items: page.items.map((row) => {
          const message = toMessage(row);
          message.body = openBody(instanceId, row);
          return message;
        }),
      };
    },

    async findById(instanceId, tenantId, messageId) {
      if (!instanceId || !tenantId || !messageId) return null;
      const row = (await rowsFor(instanceId, tenantId)).find(
        (candidate) => candidate.id === messageId || candidate.providerMessageId === messageId,
      );
      if (!row) return null;
      const message = toMessage(row);
      message.body = openBody(instanceId, row);
      return message;
    },

    async countByInstance(instanceId, tenantId) {
      return (await rowsFor(instanceId, tenantId)).length;
    },

    async purgeBefore(instanceId, cutoff) {
      const before = toMillis(cutoff);
      let removed = 0;
      await store.updateJsonl(fileFor(instanceId), (rows) => {
        const kept = rows.filter((row) => {
          if (toMillis(row.sentAt) < before) {
            removed += 1;
            return false;
          }
          return true;
        });
        return removed > 0 ? kept : undefined;
      });
      return removed;
    },

    async deleteByInstance(instanceId, tenantId) {
      const rows = await store.readJsonl(fileFor(instanceId));
      const matching = rows.filter((row) => !tenantId || row.tenantId === tenantId);
      if (matching.length > 0) await store.removeFile(fileFor(instanceId));
      return matching.length;
    },

    async reset() {
      const entries = await store.listDir(paths.instancesDir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await store.removeFile(paths.messagesFile(entry.name)).catch(() => {});
      }
    },
  };
}
