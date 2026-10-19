/**
 * Real-time connection event bus (single-process).
 *
 * Events are delivered to authenticated SSE subscribers and to internal
 * supervisors (for example the reconnection controller) through a wildcard
 * subscription. The last event per instance is cached briefly so a client that
 * connects a moment late still learns the current state.
 *
 * This deployment is deliberately single-process; there is no cross-replica
 * fan-out, so a file-based service never needs Redis.
 */
import { randomHex } from '../utils/ids.js';

export const ConnectionEventType = Object.freeze({
  STATUS: 'connection.status',
  STATE: 'connection.state',
  QR: 'auth.qr',
  QR_EXPIRED: 'auth.qr_expired',
  PAIRING_CODE: 'auth.pairing_code',
  LOADING: 'auth.loading',
  AUTH_STATE: 'auth.state',
  AUTHENTICATED: 'connection.authenticated',
  DISCONNECTED: 'connection.disconnected',
  RECONNECTING: 'connection.reconnecting',
  ERROR: 'connection.error',
  MESSAGE: 'message.received',
  MESSAGE_SENT: 'message.sent',
  METRIC: 'connector.metric',
});

const LAST_EVENT_TTL_MS = 5 * 60 * 1000;
const MAX_LISTENERS_ALL = 100;

export class ConnectionEventBus {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.listeners = new Map(); // instanceId -> Set<listener>
    this.globalListeners = new Set(); // receives every event
    this.lastEvents = new Map(); // instanceId -> { event, expiresAt }
    this.closed = false;
  }

  /**
   * Publish an event for an instance.
   * @param {string} instanceId
   * @param {string} type one of ConnectionEventType
   * @param {object} data payload delivered to subscribers
   */
  async publish(instanceId, type, data = {}) {
    const event = {
      id: `evt_${randomHex(8)}`,
      instanceId,
      type,
      at: new Date().toISOString(),
      data,
    };
    // Log the envelope only: payloads may contain QR data or a pairing code.
    this.logger?.debug({ instanceId, eventType: type }, 'connection event published');

    this.lastEvents.set(instanceId, { event, expiresAt: Date.now() + LAST_EVENT_TTL_MS });
    await this.#deliver(event);
    return event;
  }

  /**
   * Subscribe to one instance's events.
   * @returns {Promise<() => Promise<void>>} unsubscribe
   */
  async subscribe(instanceId, listener) {
    let set = this.listeners.get(instanceId);
    if (!set) {
      set = new Set();
      this.listeners.set(instanceId, set);
    }
    set.add(listener);

    // Replay the most recent event so a late subscriber is not left blind.
    const cached = this.lastEvents.get(instanceId);
    if (cached && cached.expiresAt > Date.now()) {
      try {
        await listener(cached.event);
      } catch (error) {
        this.logger?.warn({ err: error }, 'event listener threw during replay');
      }
    }

    return async () => {
      const current = this.listeners.get(instanceId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(instanceId);
    };
  }

  /**
   * Observe every event published by any instance. Used by internal supervisors.
   * @param {(event:object)=>void} listener
   * @returns {() => void} unsubscribe
   */
  subscribeAll(listener) {
    if (this.globalListeners.size >= MAX_LISTENERS_ALL) {
      throw new Error('Too many global event listeners registered.');
    }
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  getLastEvent(instanceId) {
    const cached = this.lastEvents.get(instanceId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.lastEvents.delete(instanceId);
      return null;
    }
    return cached.event;
  }

  clearLastEvent(instanceId) {
    this.lastEvents.delete(instanceId);
  }

  listenerCount(instanceId) {
    return this.listeners.get(instanceId)?.size ?? 0;
  }

  async start() {
    /* nothing to start in single-process mode */
  }

  /**
   * Deliver an event to every listener. Listeners are awaited so a connector
   * that publishes a status change cannot race the synchronous state transition
   * that follows it (for example: a late "initializing" must not overwrite the
   * CONNECTED state that a completed connect writes moments later). Rejections
   * are contained per listener.
   */
  async #deliver(event) {
    const pending = [];
    const set = this.listeners.get(event.instanceId);
    if (set) {
      for (const listener of set) pending.push(this.#invoke(listener, event, event.instanceId));
    }
    for (const listener of this.globalListeners) pending.push(this.#invoke(listener, event, event.instanceId));
    await Promise.all(pending);
  }

  async #invoke(listener, event, instanceId) {
    try {
      await listener(event);
    } catch (error) {
      this.logger?.warn({ err: error, instanceId, eventType: event.type }, 'event listener threw');
    }
  }

  async close() {
    this.closed = true;
    this.listeners.clear();
    this.globalListeners.clear();
    this.lastEvents.clear();
  }
}
