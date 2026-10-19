/**
 * Automatic reconnection supervisor.
 *
 * Subscribes to the connection event bus. When a connector reports a
 * *recoverable* disconnect or error it schedules a reconnect attempt using
 * exponential backoff with random jitter, bounded by a maximum number of
 * attempts and a maximum total duration. Exhausting either bound moves the
 * instance into a visible ERROR state and stops — there is no infinite rapid
 * reconnect loop.
 *
 * A successful, stable connection resets the attempt counter so a later
 * transient failure starts again from the base delay.
 */
import { ConnectionEventType } from '../events/connectionEvents.js';
import { ConnectionState, backoffDelay } from './connectionState.js';

export class ReconnectionService {
  constructor({ config, logger, events, connectionService, connectionRepository, instanceService, audit, sessionService }) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.connectionService = connectionService;
    this.connectionRepository = connectionRepository;
    this.instanceService = instanceService;
    this.audit = audit;
    this.sessionService = sessionService;
    this.timers = new Map(); // instanceId -> { timeout, kind }
    this.inFlight = new Set(); // instanceId -> an attempt is currently running
    this.startedAt = new Map(); // instanceId -> epoch ms of first attempt
    this.stableTimers = new Map();
    this.unsubscribe = null;
    this.closed = false;
  }

  start() {
    if (this.unsubscribe) return;
    // The bus awaits listeners, so a recoverable failure is scheduled before the
    // connector that published it resumes.
    this.unsubscribe = this.events.subscribeAll((event) => this.#onEvent(event));
  }

  async #onEvent(event) {
    if (this.closed) return;
    // While an attempt is running, a recoverable failure reported by that very
    // attempt must not schedule a second, overlapping one. The attempt's own
    // completion always reschedules.
    if (this.inFlight.has(event.instanceId)) return;
    switch (event.type) {
      case ConnectionEventType.DISCONNECTED:
        if (event.data?.recoverable) await this.schedule(event.instanceId, event.data?.reason ?? 'disconnected');
        else this.cancelStableReset(event.instanceId);
        break;
      case ConnectionEventType.ERROR:
        if (event.data?.recoverable) await this.schedule(event.instanceId, 'error');
        break;
      case ConnectionEventType.STATUS:
        if (event.data?.status === 'ready') this.#markStable(event.instanceId);
        break;
      default:
        break;
    }
  }

  #markStable(instanceId) {
    this.cancel(instanceId);
    const timer = setTimeout(() => {
      this.stableTimers.delete(instanceId);
      this.startedAt.delete(instanceId);
      void this.connectionRepository.set(instanceId, { attempt: 0, nextAttemptAt: null, lastError: null });
    }, this.config.reconnect.stableResetMs);
    timer.unref?.();
    this.stableTimers.set(instanceId, timer);
  }

  cancelStableReset(instanceId) {
    const timer = this.stableTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.stableTimers.delete(instanceId);
    }
  }

  /** Schedule the next reconnect attempt for an instance. */
  async schedule(instanceId, reason = 'error') {
    if (this.closed || !this.config.reconnect.enabled) return;

    const policy = this.config.reconnect;
    this.cancel(instanceId);

    const state = await this.connectionRepository.get(instanceId);
    const attempt = (state.attempt ?? 0) + 1;

    const firstAttemptAt = this.startedAt.get(instanceId) ?? Date.now();
    this.startedAt.set(instanceId, firstAttemptAt);

    if (attempt > policy.maxAttempts || Date.now() - firstAttemptAt > policy.maxDurationMs) {
      await this.connectionRepository.set(instanceId, {
        state: ConnectionState.ERROR,
        attempt,
        nextAttemptAt: null,
        lastError: `Automatic reconnection gave up after ${attempt - 1} attempts. Owner intervention is required.`,
        reason,
      });
      await this.connectionService.setInstanceState(instanceId, ConnectionState.ERROR, {
        reason,
        error: 'Automatic reconnection exhausted its retry budget.',
      });
      this.startedAt.delete(instanceId);
      this.logger?.warn({ instanceId, attempt }, 'automatic reconnection exhausted its retry budget');
      return;
    }

    const delay = backoffDelay(attempt, policy);
    const nextAttemptAt = new Date(Date.now() + delay);

    await this.connectionRepository.set(instanceId, {
      state: ConnectionState.RECONNECTING,
      attempt,
      nextAttemptAt,
      reason,
      lastError: state.lastError ?? null,
    });
    await this.connectionService.setInstanceState(instanceId, ConnectionState.RECONNECTING, { reason });

    this.logger?.info({ instanceId, attempt, delayMs: delay }, 'scheduled automatic reconnection');
    // Fire-and-forget: this publish re-enters the listeners (including this
    // supervisor). Errors are contained by the bus.
    void Promise.resolve(
      this.events?.publish(instanceId, ConnectionEventType.RECONNECTING, {
        state: ConnectionState.RECONNECTING,
        attempt,
        nextAttemptAt: nextAttemptAt.toISOString(),
        reason,
      }),
    ).catch(() => {});

    const timeout = setTimeout(() => {
      this.timers.delete(instanceId);
      void this.#attempt(instanceId, attempt).catch((error) =>
        this.logger?.warn({ err: error, instanceId }, 'reconnect attempt failed unexpectedly'),
      );
    }, delay);
    timeout.unref?.();
    this.timers.set(instanceId, { timeout, kind: 'reconnect' });
  }

  async #attempt(instanceId, attempt) {
    if (this.closed) return;
    // Exactly one attempt per instance at a time, even under event churn.
    if (this.inFlight.has(instanceId)) return;
    this.inFlight.add(instanceId);
    this.logger?.info({ instanceId, attempt }, 'attempting automatic reconnection');
    try {
      await this.connectionService.reconnect(instanceId, { reason: 'auto_reconnect', attempt });
      // A successful initialize updates the state; a connector that reports
      // ready marks itself stable and clears the retry counter.
    } catch (error) {
      // Never clobber a terminal ERROR written when the budget was exhausted.
      const current = await this.connectionRepository.get(instanceId);
      if (current.state !== ConnectionState.ERROR) {
        await this.connectionRepository.set(instanceId, {
          lastError: 'Automatic reconnection attempt failed.',
        });
      }
      await this.audit?.record({
        action: 'instance.reconnect_failed',
        result: 'failure',
        instanceId,
        metadata: { attempt, errorCode: error?.code ?? 'UNKNOWN' },
      });
      await this.schedule(instanceId, 'retry');
    } finally {
      this.inFlight.delete(instanceId);
    }
  }

  cancel(instanceId) {
    const entry = this.timers.get(instanceId);
    if (entry) {
      clearTimeout(entry.timeout);
      this.timers.delete(instanceId);
    }
  }

  /**
   * Startup recovery policy.
   *
   * Nothing is running after a restart, so any instance that was previously in a
   * live state is first marked DISCONNECTED. Cloud API instances (credential
   * based, safe to retry automatically) are then scheduled for one reconnect
   * when AUTO_RECONNECT_ON_STARTUP is enabled; the Web connector requires the
   * owner to re-initiate so a restart never generates unsolicited QR codes.
   */
  async recoverOnStartup() {
    const instances = await this.instanceService.repository.listAll();
    let scheduled = 0;
    for (const instance of instances) {
      const previous = await this.connectionRepository.get(instance.id);
      const wasLive = previous.state && previous.state !== ConnectionState.DISCONNECTED && previous.state !== ConnectionState.ERROR;

      if (wasLive) {
        await this.connectionRepository.set(instance.id, {
          state: ConnectionState.DISCONNECTED,
          nextAttemptAt: null,
          reason: 'process_restart',
        });
        await this.connectionService.setInstanceState(instance.id, ConnectionState.DISCONNECTED, {
          reason: 'process_restart',
        });
      }

      const shouldReconnect =
        this.config.reconnect.enabled &&
        this.config.reconnect.onStartup &&
        wasLive &&
        instance.connector === 'cloud_api';

      if (shouldReconnect) {
        await this.schedule(instance.id, 'startup_recovery');
        scheduled += 1;
      }
    }

    if (instances.length > 0) {
      this.logger?.info({ instances: instances.length, scheduled }, 'connection state recovered on startup');
    }
    return { instances: instances.length, scheduled };
  }

  async shutdown() {
    this.closed = true;
    for (const instanceId of [...this.timers.keys()]) this.cancel(instanceId);
    for (const timer of this.stableTimers.values()) clearTimeout(timer);
    this.stableTimers.clear();
    this.inFlight.clear();
    this.startedAt.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
