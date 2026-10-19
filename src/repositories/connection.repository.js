/**
 * Connection state repository (file-backed).
 *
 * The connection state machine is persisted per instance in
 * `data/instances/<id>/connection.json` so it survives a restart. The file
 * contains operational metadata only: state, attempt counters, timestamps and a
 * redacted last-error string. It never contains QR payloads, pairing codes,
 * cookies or any session material.
 */
import { reviveDates } from './support.js';

const DATE_FIELDS = ['updatedAt', 'lastAttemptAt', 'nextAttemptAt', 'connectedAt', 'disconnectedAt'];
const INSTANCE_ID_PATTERN = /^ins_[a-f0-9]{32}$/;

const DEFAULT_STATE = Object.freeze({
  state: 'DISCONNECTED',
  attempt: 0,
  lastError: null,
  updatedAt: null,
  lastAttemptAt: null,
  nextAttemptAt: null,
  connectedAt: null,
  disconnectedAt: null,
  reason: null,
});

function toState(row) {
  return reviveDates({ ...DEFAULT_STATE, ...row }, DATE_FIELDS);
}

export function createConnectionRepository({ store }) {
  const paths = store.paths;
  const fileFor = (instanceId) => paths.connectionFile(instanceId);

  return {
    async get(instanceId) {
      if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) return toState({});
      const row = await store.readJson(fileFor(instanceId), { fallback: null });
      return row ? toState(row) : toState({});
    },

    async set(instanceId, patch) {
      const next = await store.updateJson(
        fileFor(instanceId),
        (current) => toState({ ...(current ?? {}), ...patch, updatedAt: patch.updatedAt ?? new Date() }),
        { fallback: null },
      );
      return toState(next);
    },

    async delete(instanceId) {
      if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) return false;
      const existed = await store.exists(fileFor(instanceId));
      await store.removeFile(fileFor(instanceId));
      return existed;
    },

    async listAll() {
      const entries = await store.listDir(paths.instancesDir);
      const out = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !INSTANCE_ID_PATTERN.test(entry.name)) continue;
        const row = await store.readJson(fileFor(entry.name), { fallback: null });
        out.push({ instanceId: entry.name, ...toState(row ?? {}) });
      }
      return out;
    },
  };
}

export { DEFAULT_STATE as DEFAULT_CONNECTION_STATE };
