/**
 * Per-instance file locks.
 *
 * The gateway is a single-process deployment, so the authoritative guard is an
 * in-memory map: only one operation can hold a key at a time. On top of that a
 * small lock file records *who* owns the key, which lets a restart reclaim
 * locks left behind by a crashed process **only after** verifying that the
 * owning process is gone.
 *
 * A lock is never deleted just because it looks old: the recorded pid must be
 * dead (or, for the current process, must no longer match a live in-memory
 * owner) before it is reclaimed.
 *
 * Lock files live under `data/locks/` and contain no secrets.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { InstanceBusyError } from '../utils/errors.js';

const DEFAULT_TTL_MS = 120000;

export function createFileLock({ lockDir, logger = null, defaultTtlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, {token:string, acquiredAt:number}>} */
  const held = new Map();
  const lockFile = (key) => path.join(lockDir, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}.lock`);

  async function ownerIsAlive(file) {
    let info;
    try {
      info = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return false;
    }
    if (!info || typeof info.pid !== 'number') return false;

    if (info.pid === process.pid) {
      const current = held.get(info.key);
      // For our own process the lock is alive only while an in-memory owner
      // still holds the exact same token. A crashed operation leaves neither.
      return Boolean(current && current.token === info.token);
    }

    try {
      process.kill(info.pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but is owned by another user.
      return error.code === 'EPERM';
    }
  }

  /**
   * Try to acquire a lock. Returns a token when acquired, or null when the key
   * is already held by a live owner.
   *
   * The in-memory claim is reserved **synchronously** before any `await`, so two
   * concurrent callers for the same key can never both believe the lock is free.
   */
  async function acquire(key, { op = null, ttlMs = defaultTtlMs } = {}) {
    const now = Date.now();
    const existing = held.get(key);
    if (existing && now - existing.acquiredAt < ttlMs) return null;

    const token = crypto.randomBytes(16).toString('hex');
    // Reserve the key immediately; the reservation is rolled back on any failure.
    held.set(key, { token, acquiredAt: now, pending: true });

    const file = lockFile(key);
    const payload = JSON.stringify({
      key,
      token,
      pid: process.pid,
      op,
      acquiredAt: new Date(now).toISOString(),
    });

    try {
      await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let handle;
        try {
          handle = await fs.open(file, 'wx', 0o600);
          await handle.writeFile(payload);
          await handle.sync();
          held.set(key, { token, acquiredAt: Date.now(), pending: false });
          return token;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (await ownerIsAlive(file)) {
            // A live owner (possibly another process) has the lock: give up our
            // reservation so the in-memory state matches reality.
            releaseReservation(key, token);
            return null;
          }
          // The owner is gone: reclaim the stale lock.
          logger?.warn({ key }, 'reclaiming stale instance lock');
          await fs.rm(file, { force: true }).catch(() => {});
        } finally {
          if (handle) await handle.close().catch(() => {});
        }
      }
      releaseReservation(key, token);
      return null;
    } catch (error) {
      releaseReservation(key, token);
      throw error;
    }
  }

  function releaseReservation(key, token) {
    const current = held.get(key);
    if (current && current.token === token) held.delete(key);
  }

  async function release(key, token) {
    if (!token) return;
    const current = held.get(key);
    if (!current || current.token !== token) return;
    held.delete(key);
    await fs.rm(lockFile(key), { force: true }).catch(() => {});
  }

  /**
   * Run `fn` while holding `key`. Throws InstanceBusyError immediately unless
   * `waitMs` is set and the lock becomes free before the deadline.
   */
  async function withLock(key, fn, { ttlMs = defaultTtlMs, waitMs = 0, busyCode, busyMessage, op = null } = {}) {
    const deadline = Date.now() + waitMs;
    let token = null;
    for (;;) {
      token = await acquire(key, { op, ttlMs });
      if (token) break;
      if (Date.now() >= deadline) {
        throw new InstanceBusyError(busyMessage ?? 'Another operation is already in progress for this instance.', {
          code: busyCode,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let heartbeat = null;
    // Keep long operations from being mistaken for dead ones by refreshing the
    // recorded acquisition time while we still hold the token.
    if (ttlMs > 0 && ttlMs < Number.MAX_SAFE_INTEGER) {
      heartbeat = setInterval(() => {
        const current = held.get(key);
        if (current && current.token === token) current.acquiredAt = Date.now();
      }, Math.max(Math.floor(ttlMs / 2), 1000));
      heartbeat.unref?.();
    }

    try {
      return await fn();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await release(key, token);
    }
  }

  /** Reclaim locks whose owning process is no longer running (startup only). */
  async function cleanupStale() {
    let entries = [];
    try {
      entries = await fs.readdir(lockDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.lock')) continue;
      const file = path.join(lockDir, entry);
      if (await ownerIsAlive(file)) continue;
      await fs.rm(file, { force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  return {
    acquire,
    release,
    withLock,
    cleanupStale,
    /** Diagnostics only: never exposes tokens. */
    heldCount: () => held.size,
  };
}
