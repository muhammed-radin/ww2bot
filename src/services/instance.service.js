/**
 * Instance lifecycle and tenant isolation.
 *
 * An instance is the unit of isolation: one tenant-owned connector session.
 * Every read and write in this service is scoped by tenant id (and optionally
 * by the API key's instance allowlist), and a lookup that crosses a tenant
 * boundary returns 404 rather than 403 so key holders cannot probe for the
 * existence of other tenants' resources.
 */
import { ErrorCode, NotFoundError, ValidationError, ConnectorDisabledError, ConflictError } from '../utils/errors.js';
import { newInstanceId } from '../utils/ids.js';
import { ApiKeyService } from './apiKey.service.js';

export const InstanceStatus = Object.freeze({
  CREATED: 'created',
  INITIALIZING: 'initializing',
  AWAITING_QR: 'awaiting_qr',
  AWAITING_PAIRING_CODE: 'awaiting_pairing_code',
  AUTHENTICATED: 'authenticated',
  READY: 'ready',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
  DESTROYED: 'destroyed',
});

export const ConnectorType = Object.freeze({
  CLOUD_API: 'cloud_api',
  WEB: 'web',
});

const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N} .,'&()_-]{1,80}$/u;

export class InstanceService {
  constructor({ repository, config, logger, audit, cursorCodec }) {
    this.repository = repository;
    this.config = config;
    this.logger = logger;
    this.audit = audit;
    this.cursorCodec = cursorCodec;
  }

  validateConnector(connector) {
    if (connector === undefined || connector === null) return this.config.connectors.default;
    if (!Object.values(ConnectorType).includes(connector)) {
      throw new ValidationError('Unknown connector type.', {
        field: 'connector',
        allowed: Object.values(ConnectorType),
      });
    }
    if (connector === ConnectorType.WEB && !this.config.connectors.web.enabled) {
      throw new ConnectorDisabledError(
        'The WhatsApp Web connector is disabled. It requires explicit operator authorization and ENABLE_WHATSAPP_WEB_CONNECTOR=true.',
        { connector, enabled: false },
      );
    }
    return connector;
  }

  validateDisplayName(displayName) {
    if (displayName === undefined || displayName === null || displayName === '') return null;
    if (typeof displayName !== 'string' || !DISPLAY_NAME_PATTERN.test(displayName.trim())) {
      throw new ValidationError('"displayName" must be 1-80 printable characters.', { field: 'displayName' });
    }
    return displayName.trim();
  }

  validateRetention(retentionDays, retentionEnabled) {
    const enabled = retentionEnabled ?? this.config.retention.retainMessageContent;
    let days = retentionDays ?? this.config.retention.defaultDays;
    if (days === null || days === undefined) days = this.config.retention.defaultDays;
    if (!Number.isInteger(days) || days < 0) {
      throw new ValidationError('"retentionDays" must be a non-negative integer.', { field: 'retentionDays' });
    }
    if (days > this.config.retention.maxDays) {
      throw new ValidationError(`"retentionDays" must not exceed ${this.config.retention.maxDays}.`, {
        field: 'retentionDays',
        max: this.config.retention.maxDays,
      });
    }
    if (enabled && days === 0) {
      throw new ValidationError('"retentionDays" must be greater than 0 when retention is enabled.', {
        field: 'retentionDays',
      });
    }
    return { retentionEnabled: Boolean(enabled), retentionDays: days };
  }

  async create({
    tenantId,
    connector,
    displayName,
    retentionDays,
    retentionEnabled,
    metadata = {},
    requestId = null,
    actorKeyId = null,
    ip = null,
  }) {
    const resolvedConnector = this.validateConnector(connector);
    const name = this.validateDisplayName(displayName);
    const retention = this.validateRetention(retentionDays, retentionEnabled);

    if (resolvedConnector === ConnectorType.CLOUD_API) {
      const phoneNumberId = metadata?.phoneNumberId ?? null;
      if (phoneNumberId !== null && !/^\d{5,32}$/.test(String(phoneNumberId))) {
        throw new ValidationError('"metadata.phoneNumberId" must be a numeric id.', {
          field: 'metadata.phoneNumberId',
        });
      }
    }

    const record = {
      id: newInstanceId(),
      tenantId,
      connector: resolvedConnector,
      displayName: name ?? `${resolvedConnector}-instance`,
      status: InstanceStatus.CREATED,
      metadata: sanitiseInstanceMetadata(metadata),
      retentionEnabled: retention.retentionEnabled,
      retentionDays: retention.retentionDays,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
    };

    const saved = await this.repository.create(record);
    await this.audit?.record({
      action: 'instance.created',
      result: 'success',
      tenantId,
      instanceId: saved.id,
      requestId,
      actorKeyId,
      ip,
      metadata: {
        connector: saved.connector,
        retentionEnabled: saved.retentionEnabled,
        retentionDays: saved.retentionDays,
      },
    });
    return saved;
  }

  /**
   * Load an instance without a tenant check. Internal use only (supervisors,
   * recovery, health). Route handlers must use getOwned().
   */
  async getById(instanceId) {
    if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 128) return null;
    return this.repository.findById(instanceId);
  }

  /**
   * Load an instance, enforcing tenant isolation and the key's instance
   * allowlist. Throws NotFoundError when the caller is not entitled to it.
   */
  async getOwned(auth, instanceId) {
    if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 128) {
      throw new NotFoundError('Instance not found.');
    }
    const instance = await this.repository.findById(instanceId);
    if (!instance || instance.tenantId !== auth.tenantId) {
      throw new NotFoundError('Instance not found.');
    }
    ApiKeyService.assertInstanceAllowed(auth, instanceId);
    return instance;
  }

  /**
   * List the instances a key may see, newest first, with an opaque cursor.
   * @returns {Promise<{items:object[], hasMore:boolean, nextCursor:string|null}>}
   */
  async list(auth, { limit, cursor }) {
    const allowed = auth.allowedInstanceIds;
    const { items, hasMore } = await this.repository.listByTenant(auth.tenantId, { limit, cursor });
    const visible = allowed ? items.filter((instance) => allowed.includes(instance.id)) : items;
    // A filtered page may be shorter than `limit`; the cursor still points at the
    // last row the caller is entitled to see, so paging stays consistent.
    const last = visible[visible.length - 1];
    const nextCursor =
      hasMore && last && this.cursorCodec
        ? this.cursorCodec.encode({ k: 'instances', t: new Date(last.createdAt).getTime(), i: last.id })
        : null;
    return { items: visible, hasMore, nextCursor };
  }

  async updateStatus(instanceId, status, patch = {}) {
    if (!Object.values(InstanceStatus).includes(status)) {
      throw new Error(`Unknown instance status: ${status}`);
    }
    return this.repository.update(instanceId, {
      status,
      updatedAt: new Date(),
      ...patch,
    });
  }

  async markConnected(instanceId) {
    return this.repository.update(instanceId, {
      status: InstanceStatus.READY,
      updatedAt: new Date(),
      lastConnectedAt: new Date(),
    });
  }

  async updateRetention(instanceId, { retentionEnabled, retentionDays }) {
    const retention = this.validateRetention(retentionDays, retentionEnabled);
    return this.repository.update(instanceId, { ...retention, updatedAt: new Date() });
  }

  async setMetadata(instanceId, metadata) {
    return this.repository.update(instanceId, { metadata: sanitiseInstanceMetadata(metadata), updatedAt: new Date() });
  }

  async delete(instanceId) {
    return this.repository.delete(instanceId);
  }

  /** Reject an operation when the instance is being torn down. */
  assertNotDestroyed(instance) {
    if (instance.status === InstanceStatus.DESTROYED) {
      throw new ConflictError(ErrorCode.CONFLICT, 'The instance has been destroyed and cannot be reused.');
    }
  }
}

/** Instance metadata is a small, non-sensitive key/value bag. */
function sanitiseInstanceMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const allowed = {
    phoneNumberId: (value) => (value === null || value === undefined ? null : String(value).slice(0, 32)),
    label: (value) => (value === null || value === undefined ? null : String(value).slice(0, 64)),
    authorizationReference: (value) =>
      value === null || value === undefined ? null : String(value).replace(/[\r\n\t]/g, ' ').slice(0, 128),
  };
  const result = {};
  for (const [key, reader] of Object.entries(allowed)) {
    if (metadata[key] !== undefined) result[key] = reader(metadata[key]);
  }
  return result;
}

/** Public representation of an instance. Never includes session material. */
export function publicInstanceView(instance) {
  return {
    id: instance.id,
    tenantId: instance.tenantId,
    connector: instance.connector,
    displayName: instance.displayName,
    status: instance.status,
    metadata: instance.metadata ?? {},
    retention: {
      enabled: Boolean(instance.retentionEnabled),
      days: instance.retentionDays,
    },
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    lastConnectedAt: instance.lastConnectedAt,
  };
}
