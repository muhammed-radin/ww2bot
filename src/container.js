/**
 * Composition root.
 *
 * Builds every service once and wires dependencies explicitly. Nothing imports a
 * singleton, so tests can construct an isolated container with a temporary
 * data directory, an injected connector library double, and no external
 * services. Storage is the local filesystem only.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { FileStore } from './storage/fileStore.js';
import { createFileLock } from './storage/fileLock.js';
import { createRepositories } from './repositories/index.js';
import { createCursorCodec } from './utils/pagination.js';
import { createLogger } from './utils/logger.js';
import { createRateLimitStore, createRateLimiter } from './middleware/rateLimit.js';
import { createApiKeyAuth } from './middleware/apiKeyAuth.js';
import { createInstanceLoader } from './middleware/loadInstance.js';
import { ConnectionEventBus } from './events/connectionEvents.js';
import { ApiKeyService } from './services/apiKey.service.js';
import { AuditService } from './services/audit.service.js';
import { InstanceService } from './services/instance.service.js';
import { EncryptionService } from './services/encryption.service.js';
import { SessionService } from './services/session.service.js';
import { MessageStoreService } from './services/messageStore.service.js';
import { RetentionService } from './services/retention.service.js';
import { ConnectionService } from './services/connection.service.js';
import { ReconnectionService } from './services/reconnection.service.js';
import { OutboundService } from './services/outbound.service.js';
import { WebhookService } from './services/webhook.service.js';
import { AutoReplyService } from './services/autoreply.service.js';
import { StreamTokenService } from './services/streamToken.service.js';
import { OwnerSessionService } from './services/ownerSession.service.js';
import { AdminService } from './services/admin.service.js';
import { BrowserManager } from './connectors/web/browserManager.js';

export const SERVICE_CONFIG_VERSION = 1;

const require = createRequire(import.meta.url);
/** Service version, read once from package.json (never exposed with secrets). */
const SERVICE_VERSION = (() => {
  try {
    return require('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * @param {{config:object, logger?:object, store?:object,
 *          libraryFactory?:Function, cloudClientFactory?:Function}} options
 */
export function createContainer({ config, logger, store, libraryFactory = null, cloudClientFactory = null }) {
  const log = logger ?? createLogger(config);

  const fileStore = store ?? new FileStore({ root: path.resolve(config.data.dir), logger: log });

  const events = new ConnectionEventBus({ logger: log });
  const encryption = new EncryptionService({
    keys: config.encryption.keys,
    activeKeyId: config.encryption.activeKeyId,
    logger: log,
  });
  const repositories = createRepositories({ store: fileStore, encryption, logger: log });
  const cursorCodec = createCursorCodec(config.security.apiKeyPepper);
  const audit = new AuditService({ repository: repositories.audit, logger: log });
  const apiKeys = new ApiKeyService({ repository: repositories.apiKeys, config, logger: log, audit });
  const instances = new InstanceService({ repository: repositories.instances, config, logger: log, audit, cursorCodec });
  const sessions = new SessionService({
    config,
    encryption,
    repository: repositories.sessions,
    logger: log,
    audit,
    paths: fileStore.paths,
  });
  const messageStore = new MessageStoreService({ repository: repositories.messages, logger: log, config });
  const retention = new RetentionService({ config, repositories, logger: log, audit });
  const browserManager = new BrowserManager({ config, logger: log });
  const locks = createFileLock({ lockDir: fileStore.paths.locksDir, logger: log });
  // Late-bound: the Web connector needs the auto-reply service to hand it
  // inbound message content, while the service needs this connection service
  // to send a reply. The callback runs long after both are constructed.
  let autoReply = null;
  const connections = new ConnectionService({
    config,
    logger: log,
    events,
    instanceService: instances,
    sessionService: sessions,
    browserManager,
    messageStore,
    retentionService: retention,
    locks,
    audit,
    connectionRepository: repositories.connections,
    libraryFactory,
    cloudClientFactory,
    onInboundMessage: (instance, message) => autoReply?.handleInbound(instance, message),
  });
  autoReply = new AutoReplyService({
    config,
    logger: log,
    repository: repositories.autoreplies,
    connectionService: connections,
    audit,
  });
  const recipientStore = createRateLimitStore();
  const outbound = new OutboundService({
    config,
    logger: log,
    connectionService: connections,
    deliveries: repositories.deliveries,
    audit,
    recipientStore,
    messageStore,
  });
  const reconnection = new ReconnectionService({
    config,
    logger: log,
    events,
    connectionService: connections,
    connectionRepository: repositories.connections,
    instanceService: instances,
    audit,
    sessionService: sessions,
  });
  const webhooks = new WebhookService({
    config,
    logger: log,
    repositories,
    messageStore,
    events,
    audit,
    autoReply,
  });
  const streamTokens = new StreamTokenService({ config, logger: log });
  const ownerSessions = new OwnerSessionService({
    config,
    apiKeyService: apiKeys,
    logger: log,
    audit,
  });
  const admin = new AdminService({
    config,
    serviceVersion: SERVICE_VERSION,
    instanceService: instances,
    connectionService: connections,
    sessionService: sessions,
    browserManager,
    audit,
    deliveries: repositories.deliveries,
    logger: log,
  });

  /* ----------------------------- rate limits ----------------------------- */

  const rateLimitStore = createRateLimitStore();
  const byKeyOrIp = (req) => req.auth?.keyId ?? 'anonymous';
  const byKeyIpAndInstance = (req) => `${req.auth?.keyId ?? 'anonymous'}:${req.params?.instanceId ?? 'none'}`;

  const rateLimit = {
    read: createRateLimiter({ ...config.server.rateLimit.default, scope: 'read', store: rateLimitStore, keyGenerator: byKeyOrIp }),
    write: createRateLimiter({ ...config.server.rateLimit.default, scope: 'write', store: rateLimitStore, keyGenerator: byKeyOrIp }),
    admin: createRateLimiter({ ...config.server.rateLimit.default, scope: 'admin', store: rateLimitStore, keyGenerator: byKeyOrIp }),
    connect: createRateLimiter({
      ...config.server.rateLimit.connect,
      scope: 'connect',
      store: rateLimitStore,
      keyGenerator: byKeyIpAndInstance,
      message: 'Too many connection attempts. Wait before requesting another QR code or pairing code.',
    }),
    auth: createRateLimiter({ ...config.server.rateLimit.auth, scope: 'auth', store: rateLimitStore, keyGenerator: byKeyIpAndInstance }),
    send: createRateLimiter({
      ...config.server.rateLimit.send,
      scope: 'send',
      store: rateLimitStore,
      keyGenerator: byKeyOrIp,
      message: 'Too many messages sent. Slow down before retrying.',
    }),
    webhook: createRateLimiter({
      windowMs: config.server.rateLimit.default.windowMs,
      max: Math.max(config.server.rateLimit.default.max * 10, 1000),
      scope: 'webhook',
      store: rateLimitStore,
    }),
    ipOnly: createRateLimiter({ ...config.server.rateLimit.default, scope: 'ip', store: rateLimitStore }),
    login: createRateLimiter({
      ...config.server.rateLimit.auth,
      scope: 'login',
      store: rateLimitStore,
      message: 'Too many sign-in attempts. Wait before trying again.',
    }),
  };

  const { authenticate, requireScopes } = createApiKeyAuth({ apiKeyService: apiKeys, audit, ownerSessions });
  const loadInstance = createInstanceLoader({ instanceService: instances });

  let started = false;

  return {
    config,
    logger: log,
    serviceVersion: SERVICE_VERSION,
    store: fileStore,
    events,
    repositories,
    encryption,
    cursorCodec,
    audit,
    apiKeys,
    instances,
    sessions,
    messageStore,
    retention,
    browserManager,
    locks,
    connections,
    reconnection,
    outbound,
    webhooks,
    autoReply,
    streamTokens,
    ownerSessions,
    admin,
    rateLimit,
    rateLimitStore,
    authenticate,
    requireScopes,
    loadInstance,

    /**
     * Initialise persistent storage, reclaim stale locks, describe the service
     * and run startup recovery. Idempotent.
     */
    async start() {
      if (started) return { recovered: null };
      await fileStore.init();
      await locks.cleanupStale();
      await fileStore.writeJson(fileStore.paths.serviceConfigFile, {
        version: SERVICE_CONFIG_VERSION,
        createdAt: new Date().toISOString(),
        description:
          'RazorBills private WhatsApp service. Single-owner. Filesystem-backed. Do not commit this directory to version control.',
      });
      connections.start();
      reconnection.start();
      const recovered = await reconnection.recoverOnStartup();
      started = true;
      return { recovered };
    },

    /** Release every resource held by the container. Never throws. */
    async shutdown() {
      const results = await Promise.allSettled([
        reconnection.shutdown(),
        connections.shutdown(),
        events.close(),
        recipientStore.close?.(),
        rateLimitStore.close?.(),
      ]);
      ownerSessions.shutdown();
      // Best-effort: remove any temp files left by an interrupted write.
      await fileStore.cleanupTemp?.();
      return results;
    },
  };
}
