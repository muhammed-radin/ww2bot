/**
 * Express application assembly.
 *
 * Ordering matters:
 *   1. request id            - so every later log line and error is traceable
 *   2. request logging       - redacts credentials
 *   3. helmet + CORS         - security headers and allowlist before any parsing
 *   4. body parsing          - strict size limit, raw body captured for webhooks
 *   5. public routes         - health, and the signature-verified webhook receiver
 *   6. per-IP limiter        - protects the authenticated API from unauthenticated abuse
 *   7. API-key protected routes
 *   8. 404 + central error handler
 */
import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { buildCorsOptions, helmetOptions, ROUTE_SCOPES } from './config/security.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createHttpLogger } from './utils/logger.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createApiKeysRouter } from './routes/api-keys.routes.js';
import { createInstancesRouter } from './routes/instances.routes.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createChatsRouter } from './routes/chats.routes.js';
import { createMessagesRouter } from './routes/messages.routes.js';
import { createAutoReplyRouter } from './routes/autoreply.routes.js';
import { createOutboundRouter } from './routes/outbound.routes.js';
import { createWebhooksRouter } from './routes/webhooks.routes.js';
import { createConnectorsRouter } from './routes/connectors.routes.js';
import { createUiRouter } from './routes/ui.routes.js';
import { mountFrontend } from './routes/frontend.routes.js';
import { createIpAllowlist } from './middleware/ipAllowlist.js';

export function createApp({ config, container }) {
  const { logger } = container;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);
  app.set('json escape', true);

  app.use(requestIdMiddleware);

  // Optional source-IP allowlist, applied before any parsing or routing.
  if (config.server.ipAllowlist.length > 0) {
    app.use(createIpAllowlist({ allowlist: config.server.ipAllowlist, logger }));
  }

  if (!config.isTest) {
    app.use(
      pinoHttp({
        ...createHttpLogger(config, logger),
        // The request id middleware already assigned req.id.
        genReqId: (req) => req.id,
      }),
    );
  }

  app.use(helmet(helmetOptions()));
  app.use(cors(buildCorsOptions(config)));

  // Strict body limit; capture raw bytes only where a signature must be checked.
  app.use(
    express.json({
      limit: config.server.bodyLimit,
      verify(req, _res, buffer) {
        if (typeof req.originalUrl === 'string' && req.originalUrl.startsWith('/api/v1/webhooks/')) {
          req.rawBody = Buffer.from(buffer);
        }
      },
    }),
  );

  /* ------------------------------- public -------------------------------- */

  app.use(
    '/health',
    createHealthRouter({
      config,
      store: container.store,
      connections: container,
    }),
  );

  app.use(
    '/api/v1/webhooks',
    createWebhooksRouter({
      webhookService: container.webhooks,
      rateLimit: container.rateLimit,
      logger,
    }),
  );

  /* ------------------------------- protected ----------------------------- */

  const api = Router();

  api.use(container.rateLimit.ipOnly);

  // Owner dashboard support API (login/session, safe views for ww2web).
  api.use(
    '/ui',
    createUiRouter({
      config,
      ownerSessions: container.ownerSessions,
      adminService: container.admin,
      authenticate: container.authenticate,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
    }),
  );

  api.use(
    '/connectors',
    container.authenticate,
    createConnectorsRouter({
      config,
      connectionService: container.connections,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
    }),
  );

  api.use(
    '/api-keys',
    container.authenticate,
    container.requireScopes(...ROUTE_SCOPES.keysAdmin),
    createApiKeysRouter({
      apiKeyService: container.apiKeys,
      rateLimit: container.rateLimit,
    }),
  );

  // Registered before /instances so stream-token authentication is possible.
  api.use(
    '/instances/:instanceId/auth',
    createAuthRouter({
      config,
      apiKeyService: container.apiKeys,
      streamTokens: container.streamTokens,
      connectionEvents: container.events,
      connectionService: container.connections,
      authenticate: container.authenticate,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
      loadInstance: container.loadInstance,
      ownerSessions: container.ownerSessions,
    }),
  );

  api.use(
    '/instances',
    container.authenticate,
    createInstancesRouter({
      config,
      instanceService: container.instances,
      connectionService: container.connections,
      sessionService: container.sessions,
      retentionService: container.retention,
      audit: container.audit,
      cursorCodec: container.cursorCodec,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
      loadInstance: container.loadInstance,
    }),
  );

  api.use(
    '/instances/:instanceId',
    container.authenticate,
    createChatsRouter({
      config,
      connectionService: container.connections,
      cursorCodec: container.cursorCodec,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
      loadInstance: container.loadInstance,
    }),
    createMessagesRouter({
      config,
      connectionService: container.connections,
      cursorCodec: container.cursorCodec,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
      loadInstance: container.loadInstance,
    }),
    createAutoReplyRouter({
      autoReplyService: container.autoReply,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
      loadInstance: container.loadInstance,
    }),
  );

  // Outbound messaging for the RazorBills backend (narrow `messages:send` scope).
  api.use(
    '/messages',
    container.authenticate,
    createOutboundRouter({
      outboundService: container.outbound,
      instanceService: container.instances,
      requireScopes: container.requireScopes,
      rateLimit: container.rateLimit,
    }),
  );

  app.use('/api/v1', api);
  app.use('/api', notFoundHandler);

  /* ---------------------- owner dashboard (ww2web) ----------------------- */
  // Static shell + hashed assets. Public files only: nothing under DATA_DIR,
  // `src/` or `.env` is ever reachable. All data still requires authentication.
  mountFrontend(app, { logger });

  /* ------------------------------- errors -------------------------------- */

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger }));

  return app;
}
