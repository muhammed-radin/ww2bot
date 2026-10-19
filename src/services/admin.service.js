/**
 * Read-only views for the owner dashboard.
 *
 * Everything the dashboard shows is derived from real service state — never
 * invented and never hardcoded. This module is the single place that decides
 * what "safe" means for a browser client:
 *
 *   - no secrets, ever: no API-key material or digests, no encryption keys, no
 *     environment tokens, no filesystem paths, no session files;
 *   - no credentials that could be replayed: QR payloads and pairing codes are
 *     never included in an overview (they are delivered only by the dedicated
 *     connection endpoints, to the owner, and expire quickly);
 *   - recipients are masked, message bodies are never stored unless the operator
 *     explicitly enabled retention, and audit metadata is already redacted by
 *     AuditService.
 */
import { ConnectorType, publicInstanceView } from './instance.service.js';

const MAX_AUDIT_SCAN = 1000;
const MAX_DELIVERIES_SCAN = 200;

/** Best-effort grouping of audit actions for the dashboard's filters. */
const AUDIT_CATEGORY_PREFIXES = Object.freeze({
  authentication: ['auth.', 'owner.', 'api_key.'],
  security: ['security.', 'ip.', 'rate.'],
  connection: ['instance.connect_', 'instance.connected', 'instance.disconnected', 'instance.reconnected', 'instance.logged_out', 'instance.session_revoked', 'connection.', 'session.'],
  configuration: ['instance.created', 'instance.deleted', 'instance.retention_updated', 'config.'],
  messaging: ['message.', 'autoreply.'],
});

const AUDIT_CATEGORIES = Object.freeze(Object.keys(AUDIT_CATEGORY_PREFIXES));

export function auditCategories() {
  return [...AUDIT_CATEGORIES];
}

function matchesCategory(action, category) {
  const prefixes = AUDIT_CATEGORY_PREFIXES[category];
  if (!prefixes) return true;
  return prefixes.some((prefix) => String(action ?? '').startsWith(prefix));
}

/** Reduce a phone number to a non-reversible hint for display. */
export function maskRecipient(value) {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 0) return null;
  const tail = digits.slice(-4);
  return `••••${tail}`;
}

export function publicDeliveryView(record) {
  return {
    id: record.id,
    instanceId: record.instanceId,
    status: record.status,
    createdAt: record.createdAt,
    providerMessageId: record.providerMessageId ?? null,
    errorCode: record.errorCode ?? null,
    recipientMasked: maskRecipient(record.recipient),
    // idempotencyKeyHash, recipient (plaintext) and tenantId are intentionally omitted.
  };
}

function safeConfigView(config, { serviceVersion }) {
  return {
    service: {
      name: config.serviceName,
      version: serviceVersion,
      environment: config.env,
      production: config.isProduction,
      uptimeSeconds: Math.floor(process.uptime()),
      serverTime: new Date().toISOString(),
    },
    security: {
      apiKeyPepper: config.security.ephemeralApiKeyPepper ? 'ephemeral (development)' : 'configured',
      ephemeralSecrets: Boolean(config.security.ephemeralApiKeyPepper || config.encryption.ephemeral),
      encryption: {
        provider: config.encryption.provider,
        activeKeyId: config.encryption.activeKeyId,
        keyCount: Object.keys(config.encryption.keys).length,
        // Key material itself is never exposed.
      },
      corsOriginsConfigured: config.server.corsOrigins.length,
      corsWildcard: config.server.corsOrigins.includes('*'),
      ipAllowlistEnabled: config.server.ipAllowlist.length > 0,
      trustProxy: config.server.trustProxy !== false,
      bodyLimit: config.server.bodyLimit,
      ownerSession: {
        ttlMs: config.ownerSession.ttlMs,
        idleMs: config.ownerSession.idleMs,
        secureCookie: Boolean(config.ownerSession.cookieSecure),
        maxSessions: config.ownerSession.maxSessions,
      },
    },
    connectors: {
      default: config.connectors.default,
      cloud: {
        configured: config.connectors.cloud.configured,
        accessToken: config.connectors.cloud.accessToken ? 'configured' : 'not configured',
        phoneNumberId: config.connectors.cloud.phoneNumberId ? 'configured' : 'not configured',
        verifyToken: config.connectors.cloud.verifyToken ? 'configured' : 'not configured',
        appSecret: config.connectors.cloud.appSecret ? 'configured' : 'not configured',
        webhooksEnabled: config.connectors.cloud.webhooksEnabled,
        apiVersion: config.connectors.cloud.apiVersion,
        graphBaseUrl: config.connectors.cloud.graphBaseUrl,
      },
      web: {
        enabled: config.connectors.web.enabled,
        authorizationReference: config.connectors.web.authorizationReference ? 'configured' : 'not configured',
        authStrategy: config.connectors.web.authStrategy,
        headless: config.connectors.web.headless,
        maxInstances: config.connectors.web.maxInstances,
        pairingIntervalMs: config.connectors.web.pairingIntervalMs,
        launchTimeoutMs: config.connectors.web.launchTimeoutMs,
      },
    },
    reconnection: { ...config.reconnect },
    rateLimit: {
      default: { ...config.server.rateLimit.default },
      connect: { ...config.server.rateLimit.connect },
      auth: { ...config.server.rateLimit.auth },
      send: { ...config.server.rateLimit.send },
      recipient: { ...config.server.rateLimit.recipient },
    },
    retention: { ...config.retention },
    outbound: { ...config.outbound },
    events: { ...config.events },
    limits: { ...config.limits },
    pagination: { ...config.pagination },
    storage: {
      mode: 'filesystem',
      // The resolved path is deliberately NOT exposed to the browser.
      dataDirConfigured: Boolean(config.data.dir),
      dataDirIsDefault: config.data.dir === './data',
    },
    shutdown: { timeoutMs: config.shutdown.timeoutMs },
  };
}

export class AdminService {
  constructor({
    config,
    serviceVersion = '0.0.0',
    instanceService,
    connectionService,
    sessionService,
    browserManager,
    audit,
    deliveries,
    logger,
  }) {
    this.config = config;
    this.serviceVersion = serviceVersion;
    this.instances = instanceService;
    this.connections = connectionService;
    this.sessions = sessionService;
    this.browserManager = browserManager;
    this.audit = audit;
    this.deliveries = deliveries;
    this.logger = logger;
  }

  /** Safe, redacted configuration snapshot for the Configuration page. */
  configView() {
    return safeConfigView(this.config, { serviceVersion: this.serviceVersion });
  }

  /** Connector capability descriptors, so the UI can hide unsupported controls. */
  connectorView() {
    return {
      default: this.config.connectors.default,
      connectors: {
        [ConnectorType.CLOUD_API]: this.#connectorCapabilities(ConnectorType.CLOUD_API),
        [ConnectorType.WEB]: this.#connectorCapabilities(ConnectorType.WEB),
      },
    };
  }

  /**
   * Capabilities for a connector type, independent of any instance.
   *
   * A disabled connector still reports its capabilities (with `enabled: false`
   * and the reason), so the dashboard can explain why a control is absent
   * instead of failing to load.
   */
  #connectorCapabilities(connector) {
    try {
      return this.connections.describeConnectorCapabilities(connector);
    } catch (error) {
      this.logger?.warn({ err: error, connector }, 'failed to describe connector capabilities');
      return {
        connector,
        enabled: false,
        available: false,
        configured: false,
        qrAuth: false,
        pairingCode: false,
        listChats: false,
        getChat: false,
        listMessages: false,
        listContacts: false,
        historicalMessages: false,
        webhooks: false,
        outboundMessaging: false,
        limitations: ['Capability information is unavailable for this connector.'],
      };
    }
  }

  async #listOwnedInstances(auth, { limit = 100 } = {}) {
    const result = await this.instances.list(auth, { limit, cursor: null });
    return result.items;
  }

  /**
   * Aggregate snapshot for the dashboard overview. One request, real state.
   */
  async overview(auth) {
    const items = await this.#listOwnedInstances(auth);
    const byStatus = {};
    for (const instance of items) byStatus[instance.status] = (byStatus[instance.status] ?? 0) + 1;

    const primaryInstance = items[0] ?? null;
    let primary = null;
    if (primaryInstance) {
      const status = await this.connections.getStatus(primaryInstance).catch((error) => {
        this.logger?.warn({ err: error, instanceId: primaryInstance.id }, 'failed to read live connection status');
        return null;
      });
      primary = {
        instanceId: primaryInstance.id,
        displayName: primaryInstance.displayName,
        connector: primaryInstance.connector,
        status: status?.status ?? primaryInstance.status,
        connectionState: status?.connectionState ?? null,
        live: Boolean(status?.live),
        lastError: status?.lastError ?? null,
        attempt: status?.attempt ?? 0,
        nextAttemptAt: status?.nextAttemptAt ?? null,
        details: status?.details ?? {},
        qrAvailable: Boolean(status?.qr),
      };
    }

    const [recentEvents, recentDeliveries] = await Promise.all([
      this.listAudit({ auth, limit: 8 }),
      this.listDeliveries({ auth, limit: 5 }),
    ]);

    const capabilities = this.connectorView();

    return {
      service: {
        name: this.config.serviceName,
        version: this.serviceVersion,
        environment: this.config.env,
        uptimeSeconds: Math.floor(process.uptime()),
        serverTime: new Date().toISOString(),
      },
      connections: {
        total: items.length,
        byStatus,
        items: items.map(publicInstanceView),
      },
      browsers: {
        running: this.browserManager.size,
        max: this.config.connectors.web.maxInstances,
        snapshot: this.browserManager.snapshot(),
      },
      primary,
      recentEvents: recentEvents.items,
      recentDeliveries: recentDeliveries.items,
      features: {
        cloudConfigured: this.config.connectors.cloud.configured,
        webConnectorEnabled: this.config.connectors.web.enabled,
        outboundMessagingEnabled: this.config.outbound.enabled,
        qrAuth: Boolean(capabilities.connectors[ConnectorType.WEB]?.qrAuth),
        pairingCode: Boolean(capabilities.connectors[ConnectorType.WEB]?.pairingCode),
      },
    };
  }

  /**
   * Recent outbound deliveries. With no instanceId, aggregate the visible
   * instances (most recent first).
   */
  async listDeliveries({ auth, instanceId = null, limit = 50 }) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), MAX_DELIVERIES_SCAN);

    if (instanceId) {
      const instance = await this.instances.getOwned(auth, instanceId);
      const rows = await this.deliveries.list(instance.id, { limit: take });
      return { items: rows.map(publicDeliveryView) };
    }

    const instances = await this.#listOwnedInstances(auth, { limit: 50 });
    const perInstance = Math.min(Math.max(Math.ceil(take / Math.max(instances.length, 1)), 5), 50);
    const collected = [];
    for (const instance of instances) {
      const rows = await this.deliveries.list(instance.id, { limit: perInstance });
      collected.push(...rows);
    }
    collected.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { items: collected.slice(0, take).map(publicDeliveryView) };
  }

  /**
   * Sanitised audit events for the tenant, with bounded filtering.
   *
   * The repository lists by tenant/instance only, so category/result/date
   * filtering happens over a bounded scan of the most recent events. This is
   * accurate for a single-owner deployment and is documented as such.
   */
  async listAudit({ auth, instanceId = null, action = null, category = null, result = null, since = null, until = null, limit = 50, offset = 0 }) {
    const tenantId = auth.tenantId;
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);

    const scanLimit = Math.min(skip + take + 1, MAX_AUDIT_SCAN);
    const scan = await this.audit.list({ tenantId, instanceId, limit: scanLimit });

    const sinceMs = since ? new Date(since).getTime() : null;
    const untilMs = until ? new Date(until).getTime() : null;

    const filtered = scan.filter((event) => {
      if (action && event.action !== action) return false;
      if (category && !matchesCategory(event.action, category)) return false;
      if (result && event.result !== result) return false;
      const at = new Date(event.createdAt).getTime();
      if (sinceMs !== null && Number.isFinite(sinceMs) && at < sinceMs) return false;
      if (untilMs !== null && Number.isFinite(untilMs) && at > untilMs) return false;
      return true;
    });

    const page = filtered.slice(skip, skip + take);
    return {
      items: page.map(publicAuditView),
      pagination: {
        limit: take,
        offset: skip,
        returned: page.length,
        hasMore: filtered.length > skip + take,
        nextOffset: filtered.length > skip + take ? skip + take : null,
        scanned: scan.length,
      },
    };
  }
}

export function publicAuditView(event) {
  return {
    id: event.id,
    action: event.action,
    result: event.result,
    tenantId: event.tenantId ?? null,
    instanceId: event.instanceId ?? null,
    actorKeyId: event.actorKeyId ?? null,
    requestId: event.requestId ?? null,
    ip: event.ip ?? null,
    createdAt: event.createdAt,
    metadata: event.metadata ?? null,
  };
}
