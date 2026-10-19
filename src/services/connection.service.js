/**
 * Connection orchestration.
 *
 * This is the only place that creates connectors. It keeps one connector per
 * instance, serialises lifecycle operations with a per-instance file lock so two
 * requests cannot start the same browser twice, persists the connection state
 * machine, and translates connector state into instance state, connection state
 * and audit records.
 */
import { ConflictError, ConnectorDisabledError, ErrorCode, NotFoundError } from '../utils/errors.js';
import { CloudApiConnector } from '../connectors/cloudApi/cloudApi.connector.js';
import { WebConnector } from '../connectors/web/web.connector.js';
import { describeSupportedEndpoints } from '../connectors/connector.interface.js';
import { ConnectionEventType } from '../events/connectionEvents.js';
import { ConnectionState, mapConnectorStatus } from './connectionState.js';
import { ConnectorType, InstanceStatus } from './instance.service.js';

export class ConnectionService {
  constructor({
    config,
    logger,
    events,
    instanceService,
    sessionService,
    browserManager,
    messageStore,
    retentionService,
    locks,
    audit,
    connectionRepository,
    libraryFactory = null,
    cloudClientFactory = null,
    onInboundMessage = null,
  }) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.instanceService = instanceService;
    this.sessionService = sessionService;
    this.browserManager = browserManager;
    this.messageStore = messageStore;
    this.retentionService = retentionService;
    this.locks = locks;
    this.audit = audit;
    this.connectionRepository = connectionRepository;
    this.libraryFactory = libraryFactory;
    this.cloudClientFactory = cloudClientFactory;
    this.onInboundMessage = onInboundMessage;
    this.registry = new Map();
    this.unsubscribe = null;
  }

  /* ------------------------------------------------------------------ */
  /* connector construction                                              */
  /* ------------------------------------------------------------------ */

  buildConnector(instance, { allowDisabled = false } = {}) {
    if (instance.connector === ConnectorType.CLOUD_API) {
      return new CloudApiConnector({
        instance,
        config: this.config,
        logger: this.logger,
        events: this.events,
        messageStore: this.messageStore,
        clientFactory: this.cloudClientFactory ?? undefined,
      });
    }
    if (instance.connector === ConnectorType.WEB) {
      if (!this.config.connectors.web.enabled && !allowDisabled) {
        throw new ConnectorDisabledError(
          'The WhatsApp Web connector is disabled. It requires explicit operator authorization and ENABLE_WHATSAPP_WEB_CONNECTOR=true.',
          { connector: 'web', enabled: false },
        );
      }
      return new WebConnector({
        instance,
        config: this.config,
        logger: this.logger,
        events: this.events,
        sessionService: this.sessionService,
        browserManager: this.browserManager,
        libraryFactory: this.libraryFactory,
        messageStore: this.messageStore,
        onInboundMessage: this.onInboundMessage,
      });
    }
    throw new NotFoundError('Unknown connector for this instance.');
  }

  getConnector(instanceId) {
    return this.registry.get(instanceId) ?? null;
  }

  /**
   * Capability descriptor for an instance, derived from the connector itself so
   * the API always reports what the connector can genuinely do.
   */
  describeCapabilities(instance) {
    const existing = this.registry.get(instance.id) ?? this.buildConnector(instance);
    const capabilities = existing.getCapabilities();
    return { ...capabilities, supportedEndpoints: describeSupportedEndpoints(capabilities) };
  }

  /**
   * Capability descriptor for a connector type, with no instance involved.
   *
   * Discovery endpoints (the connectors catalogue and the owner dashboard use
   * this) must keep working when a connector is disabled, so the connector is
   * built even then. It reports `enabled: false` itself, which is the truth:
   * nothing here guesses at what a disabled connector would support.
   */
  describeConnectorCapabilities(connector) {
    const implementation = this.buildConnector(
      {
        id: '(unspecified)',
        tenantId: '(unspecified)',
        displayName: '(unspecified)',
        status: InstanceStatus.CREATED,
        metadata: {},
        retentionEnabled: this.config.retention.retainMessageContent,
        retentionDays: this.config.retention.defaultDays,
        connector,
      },
      { allowDisabled: true },
    );
    const capabilities = implementation.getCapabilities();
    return { ...capabilities, supportedEndpoints: describeSupportedEndpoints(capabilities) };
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle start / stop                                              */
  /* ------------------------------------------------------------------ */

  /** Subscribe to connector events so the persisted state always reflects reality. */
  start() {
    if (this.unsubscribe) return;
    // Return the promise so the event bus awaits persistence before a connector
    // continues; this keeps the persisted state ordered with connector events.
    this.unsubscribe = this.events.subscribeAll((event) => this.#onEvent(event));
  }

  async #onEvent(event) {
    const state = mapEventToState(event.type, event.data);
    if (!state) return;

    // Recoverable failures are owned by the reconnection supervisor, which moves
    // the instance to RECONNECTING (or ERROR once its retry budget is spent).
    if (
      this.config.reconnect?.enabled &&
      event.data?.recoverable === true &&
      (state === ConnectionState.DISCONNECTED || state === ConnectionState.ERROR)
    ) {
      return;
    }

    // A supervised reconnect deliberately persists RECONNECTING. The connector's
    // own "initializing" status may be delivered asynchronously and must not
    // regress a RECONNECTING (or terminal ERROR) state back to INITIALIZING —
    // that would make the instance list flap after recovery has given up.
    if (state === ConnectionState.INITIALIZING && this.config.reconnect?.enabled) {
      const current = await this.connectionRepository.get(event.instanceId);
      if (current.state === ConnectionState.RECONNECTING || current.state === ConnectionState.ERROR) return;
    }

    await this.setInstanceState(event.instanceId, state, {
      reason: event.data?.reason ?? null,
      error: event.data?.message ?? null,
    });
  }

  /**
   * Persist a connection state and mirror it onto the instance status so the
   * instance list stays meaningful. Never emits events, so it cannot recurse.
   */
  async setInstanceState(instanceId, state, { reason = null, error = null } = {}) {
    const instance = await this.instanceService.getById(instanceId);
    if (!instance) return null;

    const patch = { state, reason };
    if (error) patch.lastError = error;
    if (state === ConnectionState.CONNECTED) patch.connectedAt = new Date();
    await this.connectionRepository.set(instanceId, patch);

    if (state === ConnectionState.CONNECTED) {
      await this.instanceService.markConnected(instanceId);
    } else {
      const status = mapStateToInstanceStatus(state);
      if (status) await this.instanceService.updateStatus(instanceId, status);
    }
    return state;
  }

  async getConnectionState(instanceId) {
    return this.connectionRepository.get(instanceId);
  }

  /* ------------------------------------------------------------------ */
  /* connect                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Start (or resume) authentication for an instance.
   * @param {object} instance
   * @param {{mode?:'qr'|'pairing_code', phoneNumber?:string, force?:boolean, requestId?:string,
   *          actorKeyId?:string, ip?:string}} options
   */
  async connect(instance, { mode = 'qr', phoneNumber = null, force = false, requestId = null, actorKeyId = null, ip = null } = {}) {
    this.instanceService.assertNotDestroyed(instance);

    return this.locks.withLock(
      `instance:${instance.id}:connect`,
      async () => {
        await this.setInstanceState(instance.id, ConnectionState.INITIALIZING, { reason: 'connect_requested' });
        await this.audit?.record({
          action: 'instance.connect_requested',
          result: 'success',
          tenantId: instance.tenantId,
          instanceId: instance.id,
          requestId,
          actorKeyId,
          ip,
          metadata: { connector: instance.connector, mode },
        });

        let connector = this.registry.get(instance.id);
        if (!connector) {
          connector = this.buildConnector(instance);
          this.registry.set(instance.id, connector);
        }

        try {
          let result;
          if (instance.connector === ConnectorType.CLOUD_API) {
            result = await connector.initialize();
          } else if (mode === 'pairing_code') {
            result = await connector.requestPairingCode(phoneNumber, { force });
          } else {
            result = await connector.requestQrAuth();
          }

          const status = result?.status ?? connector.status ?? InstanceStatus.CREATED;
          await this.setInstanceState(instance.id, mapConnectorStatus(status), { reason: mode });

          await this.audit?.record({
            action: 'instance.connected',
            result: 'success',
            tenantId: instance.tenantId,
            instanceId: instance.id,
            requestId,
            actorKeyId,
            ip,
            metadata: { connector: instance.connector, mode, status },
          });

          return { ...result, status, capabilities: this.describeCapabilities({ ...instance, status }) };
        } catch (error) {
          this.registry.delete(instance.id);
          await this.setInstanceState(instance.id, ConnectionState.ERROR, {
            reason: mode,
            error: error?.message ?? 'Connection attempt failed.',
          });
          await this.audit?.record({
            action: 'instance.connect_requested',
            result: 'failure',
            tenantId: instance.tenantId,
            instanceId: instance.id,
            requestId,
            actorKeyId,
            ip,
            metadata: { connector: instance.connector, mode, errorCode: error?.code ?? 'UNKNOWN' },
          });
          throw error;
        }
      },
      {
        ttlMs: Math.max(this.config.connectors.web.launchTimeoutMs + 15000, 60000),
        busyMessage: 'A connect operation is already in progress for this instance.',
      },
    );
  }

  /**
   * Re-initialise an instance that a supervisor decided should be recovered.
   * Runs under the same per-instance lock as connect so it can never race an
   * operator-initiated start.
   */
  async reconnect(instanceId, { reason = 'auto_reconnect', attempt = 1 } = {}) {
    const instance = await this.instanceService.getById(instanceId);
    if (!instance) return null;
    if (instance.status === InstanceStatus.DESTROYED) return null;

    return this.locks.withLock(
      `instance:${instanceId}:connect`,
      async () => {
        let connector = this.registry.get(instanceId);
        if (!connector) {
          connector = this.buildConnector(instance);
          this.registry.set(instanceId, connector);
        } else if (typeof connector.resetForReconnect === 'function') {
          // Web connector: tear down any half-open client before restarting.
          await connector.resetForReconnect();
        }

        await this.setInstanceState(instanceId, ConnectionState.RECONNECTING, { reason });
        const result = await connector.initialize();

        const status = result?.status ?? connector.status ?? InstanceStatus.CREATED;
        await this.setInstanceState(instanceId, mapConnectorStatus(status), { reason });

        await this.audit?.record({
          action: 'instance.reconnected',
          result: 'success',
          tenantId: instance.tenantId,
          instanceId,
          metadata: { connector: instance.connector, reason, attempt, status },
        });
        return result;
      },
      {
        ttlMs: Math.max(this.config.connectors.web.launchTimeoutMs + 15000, 60000),
        waitMs: 10000,
        busyMessage: 'A connect or reconnect operation is already in progress for this instance.',
      },
    );
  }

  /* ------------------------------------------------------------------ */
  /* status                                                              */
  /* ------------------------------------------------------------------ */

  async getStatus(instance) {
    const connector = this.registry.get(instance.id);
    const capabilities = this.describeCapabilities(instance);
    const connection = await this.connectionRepository.get(instance.id);
    const base = {
      instanceId: instance.id,
      connector: instance.connector,
      connectionState: connection.state,
      attempt: connection.attempt ?? 0,
      nextAttemptAt: connection.nextAttemptAt ?? null,
      lastError: connection.lastError ?? null,
      capabilities,
    };
    if (!connector) {
      return { ...base, status: instance.status, live: false, details: {} };
    }
    const status = await connector.getStatus();
    return {
      ...base,
      status: status.status ?? instance.status,
      live: true,
      details: status.details ?? {},
      lastError: status.lastError ?? base.lastError,
      qr: status.qr ?? null,
    };
  }

  /** Latest QR challenge for an instance, if the connector has one pending. */
  getPendingQr(instance) {
    const connector = this.registry.get(instance.id);
    if (!connector || typeof connector.currentQr !== 'function') return null;
    return connector.currentQr();
  }

  /* ------------------------------------------------------------------ */
  /* data access                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the connector that should serve a request.
   * Cloud API reads come from retained data, so they work without a live
   * browser; the Web connector needs its live client.
   */
  requireConnector(instance, { createIfMissing = true } = {}) {
    const existing = this.registry.get(instance.id);
    if (existing) return existing;
    if (!createIfMissing) throw new ConflictError(ErrorCode.INSTANCE_NOT_CONNECTED, 'The instance is not connected.');
    if (instance.connector === ConnectorType.WEB) {
      throw new ConflictError(
        ErrorCode.INSTANCE_NOT_CONNECTED,
        'The instance is not connected. Complete QR or pairing-code authentication first.',
        { status: instance.status },
      );
    }
    const connector = this.buildConnector(instance);
    this.registry.set(instance.id, connector);
    return connector;
  }

  /**
   * Instance-wide recorded history (incoming and outgoing), newest first.
   * Retained content comes from the store; when retention is off, the live
   * connector's bounded in-memory buffer is used instead of inventing data.
   */
  async listRecentMessages(instance, options = {}) {
    if (this.messageStore.retentionEnabled(instance)) {
      const stored = await this.messageStore.listRecent(instance, options);
      if (stored.items.length > 0) return stored;
    }
    const connector = this.registry.get(instance.id);
    if (connector && typeof connector.listRecentMessages === 'function') {
      return connector.listRecentMessages(options);
    }
    return {
      items: [],
      hasMore: false,
      limitations: [
        'Message content retention is disabled for this instance, so no stored history is available.',
        'Enable retention (or keep the connector running) to read recorded incoming and outgoing messages.',
      ],
    };
  }

  /** One recorded message, falling back to the live connector buffer. */
  async getMessageById(instance, messageId) {
    const stored = await this.messageStore.getMessage(instance, messageId);
    if (stored) return stored;
    const connector = this.registry.get(instance.id);
    if (connector && typeof connector.getMessageById === 'function') {
      return connector.getMessageById(messageId);
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* teardown                                                            */
  /* ------------------------------------------------------------------ */

  async disconnect(instance, { logout = false, requestId = null, actorKeyId = null, ip = null } = {}) {
    return this.locks.withLock(
      `instance:${instance.id}:connect`,
      async () => {
        const connector = this.registry.get(instance.id);
        let result = { status: instance.status, sessionRevoked: false };
        if (connector) {
          result = (await connector.disconnect({ logout })) ?? result;
          if (!this.browserManager.isRunning(instance.id)) this.registry.delete(instance.id);
        }
        if (logout) {
          await this.sessionService.destroySession(instance, { reason: 'logout' });
        }
        await this.setInstanceState(instance.id, ConnectionState.DISCONNECTED, { reason: logout ? 'logout' : 'disconnect' });
        await this.audit?.record({
          action: logout ? 'instance.logged_out' : 'instance.disconnected',
          result: 'success',
          tenantId: instance.tenantId,
          instanceId: instance.id,
          requestId,
          actorKeyId,
          ip,
          metadata: { logout, sessionRevoked: result.sessionRevoked ?? false },
        });
        return { ...result, status: InstanceStatus.DISCONNECTED };
      },
      { busyMessage: 'A connect or disconnect operation is already in progress for this instance.' },
    );
  }

  /** Remove stored authentication material without deleting the instance. */
  async revokeSession(instance, { requestId = null, actorKeyId = null, ip = null } = {}) {
    return this.locks.withLock(
      `instance:${instance.id}:connect`,
      async () => {
        const connector = this.registry.get(instance.id);
        if (connector) {
          await connector.disconnect({ logout: true });
          this.registry.delete(instance.id);
        }
        const sessionResult = await this.sessionService.destroySession(instance, { reason: 'session_revoked' });
        await this.setInstanceState(instance.id, ConnectionState.DISCONNECTED, { reason: 'session_revoked' });
        await this.audit?.record({
          action: 'instance.session_revoked',
          result: 'success',
          tenantId: instance.tenantId,
          instanceId: instance.id,
          requestId,
          actorKeyId,
          ip,
          metadata: sessionResult,
        });
        return sessionResult;
      },
      { busyMessage: 'A connect or disconnect operation is already in progress for this instance.' },
    );
  }

  /**
   * Full teardown for DELETE /instances/:id: stop the connector, purge retained
   * data and session material, then delete the instance directory.
   */
  async deleteInstance(instance, { requestId = null, actorKeyId = null, ip = null } = {}) {
    return this.locks.withLock(
      `instance:${instance.id}:connect`,
      async () => {
        const connector = this.registry.get(instance.id);
        if (connector) {
          try {
            await connector.destroy();
          } catch (error) {
            this.logger?.warn({ err: error, instanceId: instance.id }, 'connector destroy failed during instance deletion');
          }
          this.registry.delete(instance.id);
        }
        await this.browserManager.release(instance.id, { destroy: true });

        const retention = await this.retentionService.purgeInstance(instance, { reason: 'instance_deleted', requestId, actorKeyId });
        const deliveries = await this.retentionService.purgeDeliveries(instance);
        const session = await this.sessionService.destroySession(instance, { reason: 'instance_deleted' });

        await this.connectionRepository.delete(instance.id);
        await this.instanceService.delete(instance.id);
        this.events.clearLastEvent(instance.id);

        await this.audit?.record({
          action: 'instance.deleted',
          result: 'success',
          tenantId: instance.tenantId,
          instanceId: instance.id,
          requestId,
          actorKeyId,
          ip,
          metadata: { ...retention, ...session, deliveries },
        });

        return { retention, deliveries, session };
      },
      { busyMessage: 'A lifecycle operation is in progress for this instance; try again shortly.' },
    );
  }

  /** Rotate every process-held browser. Safe to run more than once. */
  async shutdown() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const connectorCount = this.registry.size;
    const browsersOpen = this.browserManager.size;
    const connectorIds = [...this.registry.keys()];
    for (const instanceId of connectorIds) {
      const connector = this.registry.get(instanceId);
      try {
        await connector?.destroy?.();
      } catch (error) {
        this.logger?.warn({ err: error, instanceId }, 'failed to destroy connector during shutdown');
      }
    }
    this.registry.clear();
    const closedByManager = await this.browserManager.closeAll();
    return { connectors: connectorCount, browsersClosed: Math.max(browsersOpen, closedByManager) };
  }
}

function mapEventToState(type, data) {
  switch (type) {
    case ConnectionEventType.QR:
    case ConnectionEventType.QR_EXPIRED:
      return ConnectionState.QR_REQUIRED;
    case ConnectionEventType.PAIRING_CODE:
    case ConnectionEventType.AUTHENTICATED:
      return ConnectionState.AUTHENTICATING;
    case ConnectionEventType.DISCONNECTED:
      return ConnectionState.DISCONNECTED;
    case ConnectionEventType.ERROR:
      return ConnectionState.ERROR;
    case ConnectionEventType.RECONNECTING:
      return ConnectionState.RECONNECTING;
    case ConnectionEventType.STATUS:
      return data?.status ? mapConnectorStatus(data.status) : null;
    default:
      return null;
  }
}

function mapStateToInstanceStatus(state) {
  switch (state) {
    case ConnectionState.INITIALIZING:
      return InstanceStatus.INITIALIZING;
    case ConnectionState.RECONNECTING:
      return InstanceStatus.RECONNECTING;
    case ConnectionState.QR_REQUIRED:
      return InstanceStatus.AWAITING_QR;
    case ConnectionState.AUTHENTICATING:
      return InstanceStatus.AUTHENTICATED;
    case ConnectionState.CONNECTED:
      return InstanceStatus.READY;
    case ConnectionState.ERROR:
      return InstanceStatus.ERROR;
    case ConnectionState.DISCONNECTED:
      return InstanceStatus.DISCONNECTED;
    default:
      return null;
  }
}
