/**
 * Browser lifecycle management for the authorised WhatsApp Web connector.
 *
 * Responsibilities:
 *  - admission control: never run more Chromium instances than
 *    MAX_BROWSER_INSTANCES, so one misbehaving instance cannot exhaust the host;
 *  - one browser per instance: a second initialisation of the same instance is
 *    rejected instead of launching a duplicate profile;
 *  - deterministic teardown on disconnect, crash and server shutdown.
 *
 * The sandbox is never disabled here. The process runs as a non-root user and
 * Chromium keeps its own sandbox; see the README for the container
 * prerequisites that make this work without weakening isolation.
 */
import { AppError, ConflictError, ErrorCode } from '../../utils/errors.js';

export class InstanceLimitReachedError extends AppError {
  constructor(limit) {
    super(
      ErrorCode.INSTANCE_LIMIT_REACHED,
      `The maximum number of concurrent browser instances (${limit}) has been reached.`,
      { status: 409, details: { limit, code: ErrorCode.INSTANCE_LIMIT_REACHED } },
    );
  }
}

export class BrowserManager {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.maxInstances = config.connectors.web.maxInstances;
    this.slots = new Map(); // instanceId -> { startedAt, client, browser, mode }
  }

  get size() {
    return this.slots.size;
  }

  isRunning(instanceId) {
    return this.slots.has(instanceId);
  }

  /** Reserve a slot for an instance. Throws when at capacity or already running. */
  reserve(instanceId) {
    if (this.slots.has(instanceId)) {
      throw new ConflictError(
        ErrorCode.INSTANCE_BUSY,
        'A browser session for this instance is already starting or running.',
        { instanceId },
      );
    }
    if (this.slots.size >= this.maxInstances) {
      throw new InstanceLimitReachedError(this.maxInstances);
    }
    this.slots.set(instanceId, { startedAt: new Date(), client: null, browser: null, mode: null });
  }

  attach(instanceId, { client, browser, mode }) {
    const slot = this.slots.get(instanceId);
    if (!slot) throw new Error(`No browser slot reserved for instance ${instanceId}`);
    slot.client = client ?? null;
    slot.browser = browser ?? null;
    slot.mode = mode ?? null;
    return slot;
  }

  get(instanceId) {
    return this.slots.get(instanceId) ?? null;
  }

  /** Non-sensitive snapshot for diagnostics: never includes session data. */
  snapshot() {
    return [...this.slots.entries()].map(([instanceId, slot]) => ({
      instanceId,
      startedAt: slot.startedAt,
      mode: slot.mode,
      running: Boolean(slot.client),
    }));
  }

  /** Release a slot, optionally destroying the underlying browser first. */
  async release(instanceId, { destroy = true, timeoutMs = 15000 } = {}) {
    const slot = this.slots.get(instanceId);
    if (!slot) return;
    this.slots.delete(instanceId);

    const client = slot.client;
    if (destroy && client?.destroy) {
      try {
        await withTimeout(client.destroy(), timeoutMs);
      } catch (error) {
        this.logger?.warn({ err: error, instanceId }, 'failed to destroy browser client cleanly');
      }
    }

    const browser = slot.browser ?? client?.pupBrowser;
    if (browser?.close) {
      try {
        await withTimeout(browser.close(), timeoutMs);
      } catch (error) {
        this.logger?.warn({ err: error, instanceId }, 'failed to close browser cleanly');
      }
    }
  }

  /** Graceful shutdown: close every browser, never throw into the signal handler. */
  async closeAll({ timeoutMs = 15000 } = {}) {
    const instanceIds = [...this.slots.keys()];
    await Promise.allSettled(instanceIds.map((instanceId) => this.release(instanceId, { destroy: true, timeoutMs })));
    return instanceIds.length;
  }
}

export function withTimeout(promise, timeoutMs, message = 'The operation timed out.') {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError(ErrorCode.CONNECTOR_ERROR, message, { status: 504 })), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
