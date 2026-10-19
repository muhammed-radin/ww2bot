/**
 * File-based persistence primitives.
 *
 * Everything stored by the gateway goes through this one object so the safety
 * rules are implemented once:
 *
 *  - **Atomic writes.** Data is written to a uniquely named temporary file in
 *    the same directory, flushed, then renamed over the target. A reader never
 *    observes a half-written file, and an interrupted write leaves either the
 *    old file or the new one — never a corrupt mixture.
 *  - **Serialised updates.** A keyed mutex serialises read-modify-write cycles
 *    for the same file, so two concurrent requests cannot lose an update.
 *  - **Corruption tolerance.** A file that cannot be parsed or fails its schema
 *    check is quarantined (renamed aside) and reported; the caller receives the
 *    documented fallback instead of the process crashing.
 *  - **Restrictive permissions.** Directories are 0700 and files 0600.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, ErrorCode } from '../utils/errors.js';
import { createMutex } from './mutex.js';
import { createPaths } from './paths.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_READ_BYTES = 64 * 1024 * 1024;

export class FileStore {
  /**
   * @param {{root:string, logger?:object}} options
   */
  constructor({ root, logger = null }) {
    this.paths = createPaths({ root });
    this.root = this.paths.root;
    this.logger = logger;
    this.mutex = createMutex();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Create the data directory tree and prove it is writable. Throws a clear,
   * secret-free error when the storage is unavailable so the process can fail
   * fast instead of silently losing every session on the next restart.
   */
  async init() {
    try {
      await fs.mkdir(this.root, { recursive: true, mode: DIR_MODE });
      await fs.chmod(this.root, DIR_MODE).catch(() => {});

      for (const directory of [
        this.paths.configDir,
        this.paths.apiKeysDir,
        this.paths.auditDir,
        this.paths.instancesDir,
        this.paths.locksDir,
        this.paths.tmpDir,
        this.paths.rateLimitsDir,
      ]) {
        await fs.mkdir(directory, { recursive: true, mode: DIR_MODE });
        await fs.chmod(directory, DIR_MODE).catch(() => {});
      }

      await this.#assertWritable();
      await this.#sweepTempFiles();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        `Persistent storage at DATA_DIR is not usable: ${error.message}`,
        { status: 503, details: { code: 'DATA_DIR_UNAVAILABLE' }, cause: error },
      );
    }
    return this;
  }

  async #assertWritable() {
    const probe = path.join(this.paths.tmpDir, `.probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await fs.writeFile(probe, 'ok', { mode: FILE_MODE });
    await fs.rm(probe, { force: true });
  }

  /** Remove leftover temporary files from an interrupted previous run. */
  async #sweepTempFiles() {
    for (const directory of [this.paths.tmpDir, this.paths.apiKeysDir, this.paths.instancesDir]) {
      let entries = [];
      try {
        entries = await fs.readdir(directory);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith('.tmp-') && !entry.includes('.tmp-')) continue;
        await fs.rm(path.join(directory, entry), { force: true }).catch(() => {});
      }
    }
  }

  /** Public form of the temp sweep, used on graceful shutdown. Never throws. */
  async cleanupTemp() {
    try {
      await this.#sweepTempFiles();
    } catch {
      /* best effort */
    }
  }

  /* ------------------------------------------------------------------ */
  /* generic fs helpers                                                  */
  /* ------------------------------------------------------------------ */

  async ensureDir(directory, mode = DIR_MODE) {
    await fs.mkdir(directory, { recursive: true, mode });
    await fs.chmod(directory, mode).catch(() => {});
    return directory;
  }

  async exists(target) {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async listDir(directory) {
    try {
      return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async removeFile(target) {
    await fs.rm(target, { force: true });
  }

  async removeDir(directory) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }

  #tempPath(file) {
    const directory = path.dirname(file);
    const base = path.basename(file);
    return path.join(directory, `.tmp-${base}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  }

  async #writeAtomic(file, contents, { mode = FILE_MODE } = {}) {
    const directory = path.dirname(file);
    await this.ensureDir(directory);
    const temp = this.#tempPath(file);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', mode);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, file);
      await fs.chmod(file, mode).catch(() => {});
      await this.#fsyncDir(directory);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #fsyncDir(directory) {
    try {
      const handle = await fs.open(directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is not supported on every platform/filesystem.
    }
  }

  async #quarantine(file, reason) {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, target);
      this.logger?.error({ file, quarantinedAs: target, reason }, 'quarantined an unreadable data file');
    } catch (error) {
      this.logger?.error({ err: error, file, reason }, 'failed to quarantine a corrupt data file');
    }
  }

  /* ------------------------------------------------------------------ */
  /* JSON                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Read a JSON file. Missing files yield the fallback. Files that are empty,
   * unparseable, or that fail `validate` are quarantined and the fallback is
   * returned, so the caller can rebuild them safely.
   * @param {string} file
   * @param {{fallback?:unknown, validate?:(value:unknown)=>boolean}} [options]
   */
  async readJson(file, { fallback = null, validate = null } = {}) {
    return this.mutex.run(file, async () => this.#readJsonUnlocked(file, { fallback, validate }));
  }

  async #readJsonUnlocked(file, { fallback = null, validate = null } = {}) {
    let raw;
    try {
      const stats = await fs.stat(file);
      if (stats.size === 0) return fallback;
      if (stats.size > MAX_READ_BYTES) {
        await this.#quarantine(file, 'file exceeds the maximum readable size');
        return fallback;
      }
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      // Transient errors (EACCES, EIO, ...) are reported but not destructive.
      this.logger?.error({ err: error, file }, 'failed to read data file');
      return fallback;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.#quarantine(file, `invalid JSON: ${error.message}`);
      return fallback;
    }

    if (validate && !validate(parsed)) {
      await this.#quarantine(file, 'failed schema validation');
      return fallback;
    }
    return parsed;
  }

  /** Atomically write a JSON value. */
  async writeJson(file, value, { mode = FILE_MODE } = {}) {
    return this.mutex.run(file, async () => {
      await this.#writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
    });
  }

  /**
   * Serialised read-modify-write. `update` receives the current value (or the
   * fallback) and returns the next value. Returning `undefined` skips the write.
   * @template T
   * @param {string} file
   * @param {(current:T)=>T|Promise<T>} update
   * @param {{fallback?:T, validate?:(value:unknown)=>boolean, mode?:number}} [options]
   * @returns {Promise<T>}
   */
  async updateJson(file, update, { fallback = null, validate = null, mode = FILE_MODE } = {}) {
    return this.mutex.run(file, async () => {
      const current = await this.#readJsonUnlocked(file, { fallback, validate });
      const next = await update(current);
      if (next === undefined) return current;
      await this.#writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode });
      return next;
    });
  }

  /* ------------------------------------------------------------------ */
  /* JSON Lines (append-only logs)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Read a JSONL file. Individual unparseable lines are skipped and counted; a
   * file that is entirely unreadable is quarantined. Returns the parsed rows in
   * file order.
   */
  async readJsonl(file) {
    return this.mutex.run(file, async () => this.#readJsonlUnlocked(file));
  }

  async #readJsonlUnlocked(file) {
    let raw;
    try {
      const stats = await fs.stat(file);
      if (stats.size === 0) return [];
      if (stats.size > MAX_READ_BYTES) {
        await this.#quarantine(file, 'file exceeds the maximum readable size');
        return [];
      }
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      this.logger?.error({ err: error, file }, 'failed to read data file');
      return [];
    }

    const rows = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      this.logger?.warn({ file, skipped }, 'skipped unreadable lines while reading a data file');
    }
    return rows;
  }

  /** Serialised append of one JSON line, flushed to disk before returning. */
  async appendJsonl(file, row) {
    return this.mutex.run(file, async () => {
      await this.ensureDir(path.dirname(file));
      const handle = await fs.open(file, 'a', FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(row)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /** Atomically replace an entire JSONL file (used by retention/purge). */
  async writeJsonl(file, rows) {
    const contents = rows.map((row) => JSON.stringify(row)).join('\n');
    return this.mutex.run(file, async () => {
      await this.#writeAtomic(file, contents === '' ? '' : `${contents}\n`);
    });
  }

  /**
   * Serialised read-modify-write for a JSONL file. `update` receives the parsed
   * rows and returns the next set (or `undefined` to skip the write). Because
   * the read and the write happen under the same mutex, a concurrent append can
   * never be lost.
   * @param {string} file
   * @param {(rows:object[])=>object[]|undefined|Promise<object[]|undefined>} update
   */
  async updateJsonl(file, update) {
    return this.mutex.run(file, async () => {
      const current = await this.#readJsonlUnlocked(file);
      const next = await update(current);
      if (next === undefined) return current;
      const contents = next.map((row) => JSON.stringify(row)).join('\n');
      await this.#writeAtomic(file, contents === '' ? '' : `${contents}\n`);
      return next;
    });
  }

  /* ------------------------------------------------------------------ */
  /* raw text (encrypted session archives)                               */
  /* ------------------------------------------------------------------ */

  async readText(file) {
    return this.mutex.run(file, async () => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    });
  }

  async writeText(file, contents, { mode = FILE_MODE } = {}) {
    return this.mutex.run(file, async () => {
      await this.#writeAtomic(file, contents, { mode });
    });
  }
}
