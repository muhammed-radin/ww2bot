/**
 * Instance management, connection control and session administration.
 *
 * Every route requires an API key with the matching scope, loads the instance
 * through the tenant-isolating loader, and delegates to services — no business
 * logic lives in the route handlers.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ROUTE_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { publicInstanceView } from '../services/instance.service.js';
import { parsePagination } from '../utils/pagination.js';
import { createInstanceBody, instanceIdParams, listInstancesQuery, pairingCodeBody, retentionBody } from '../validators/instance.validator.js';
import { created, ok, paginationMeta } from '../utils/respond.js';

const disconnectBody = z.object({ logout: z.boolean().optional() }).optional();

const auditQuery = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  action: z.string().max(64).optional(),
});

export function createInstancesRouter({
  config,
  instanceService,
  connectionService,
  sessionService,
  retentionService,
  audit,
  cursorCodec,
  requireScopes,
  rateLimit,
  loadInstance,
}) {
  const router = Router();

  /* ----------------------------- create / list ---------------------------- */

  router.post(
    '/',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ body: createInstanceBody }),
    async (req, res) => {
      const body = req.valid.body;
      const instance = await instanceService.create({
        tenantId: req.auth.tenantId,
        connector: body.connector,
        displayName: body.displayName,
        retentionDays: body.retentionDays,
        retentionEnabled: body.retentionEnabled,
        metadata: body.metadata ?? {},
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
      });
      created(res, {
        instance: publicInstanceView(instance),
        capabilities: connectionService.describeCapabilities(instance),
      });
    },
  );

  router.get(
    '/',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.instancesRead),
    validate({ query: listInstancesQuery }),
    async (req, res) => {
      const { limit, cursor } = parsePagination(req.valid.query, config.pagination, {
        kind: 'instances',
        codec: cursorCodec,
      });
      const result = await instanceService.list(req.auth, { limit, cursor });
      ok(
        res,
        { items: result.items.map(publicInstanceView) },
        {
          pagination: paginationMeta({
            limit,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
            returned: result.items.length,
          }),
        },
      );
    },
  );

  /* ------------------------------ read detail ---------------------------- */

  router.get(
    '/:instanceId',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.instancesRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      ok(res, {
        instance: publicInstanceView(req.instance),
        capabilities: connectionService.describeCapabilities(req.instance),
      });
    },
  );

  router.get(
    '/:instanceId/status',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.connectionRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      ok(res, await connectionService.getStatus(req.instance));
    },
  );

  router.get(
    '/:instanceId/capabilities',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.instancesRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      ok(res, {
        instanceId: req.instance.id,
        connector: req.instance.connector,
        capabilities: connectionService.describeCapabilities(req.instance),
      });
    },
  );

  /* ------------------------------- connect -------------------------------- */

  router.post(
    '/:instanceId/connect/qr',
    rateLimit.connect,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      const result = await connectionService.connect(req.instance, {
        mode: 'qr',
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
      });
      const qr = connectionService.getPendingQr(req.instance) ?? result.qr ?? null;
      ok(res, {
        instanceId: req.instance.id,
        connector: req.instance.connector,
        status: result.status,
        qr,
        qrExpiresAt: qr?.expiresAt ?? null,
        eventsEndpoint: `/api/v1/instances/${req.instance.id}/auth/events`,
        capabilities: result.capabilities,
        note: 'QR payloads are short-lived authentication credentials. Deliver them only to authorised clients.',
      });
    },
  );

  router.post(
    '/:instanceId/connect/pairing-code',
    rateLimit.connect,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams, body: pairingCodeBody }),
    loadInstance,
    async (req, res) => {
      const { phoneNumber, force } = req.valid.body;
      const result = await connectionService.connect(req.instance, {
        mode: 'pairing_code',
        phoneNumber,
        force: Boolean(force),
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
      });
      ok(res, {
        instanceId: req.instance.id,
        connector: req.instance.connector,
        status: result.status,
        pairingCode: result.pairingCode ?? null,
        expiresAt: result.expiresAt ?? null,
        reused: Boolean(result.reused),
        capabilities: result.capabilities,
        note: 'This is a WhatsApp Web device-linking code used to link a device. It is not an SMS verification code.',
      });
    },
  );

  /* ------------------------------ disconnect ------------------------------ */

  router.post(
    '/:instanceId/disconnect',
    rateLimit.connect,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams, body: disconnectBody }),
    loadInstance,
    async (req, res) => {
      const logout = Boolean(req.valid.body?.logout);
      const result = await connectionService.disconnect(req.instance, {
        logout,
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
      });
      ok(res, {
        instanceId: req.instance.id,
        status: result.status,
        sessionRevoked: Boolean(result.sessionRevoked),
        note: logout
          ? 'Logout also removed the stored session material.'
          : 'The stored session was kept so the instance can reconnect.',
      });
    },
  );

  /* -------------------------------- session ------------------------------- */

  router.get(
    '/:instanceId/session',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.instancesRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      ok(res, { instanceId: req.instance.id, session: await sessionService.describe(req.instance) });
    },
  );

  router.delete(
    '/:instanceId/session',
    rateLimit.connect,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      const result = await connectionService.revokeSession(req.instance, {
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
      });
      ok(res, { instanceId: req.instance.id, sessionRevoked: true, ...result });
    },
  );

  /* ------------------------------- retention ------------------------------ */

  router.get(
    '/:instanceId/retention',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.instancesRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      ok(res, { instanceId: req.instance.id, retention: await retentionService.describe(req.instance) });
    },
  );

  router.put(
    '/:instanceId/retention',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams, body: retentionBody }),
    loadInstance,
    async (req, res) => {
      const body = req.valid.body;
      const updated = await instanceService.updateRetention(req.instance.id, {
        retentionEnabled: body.retentionEnabled ?? req.instance.retentionEnabled,
        retentionDays: body.retentionDays ?? req.instance.retentionDays,
      });
      await audit.record({
        action: 'instance.retention_updated',
        result: 'success',
        tenantId: req.instance.tenantId,
        instanceId: req.instance.id,
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
        metadata: { retentionEnabled: updated.retentionEnabled, retentionDays: updated.retentionDays },
      });
      ok(res, { instanceId: updated.id, retention: await retentionService.describe(updated) });
    },
  );

  router.post(
    '/:instanceId/data/purge',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      const result = await retentionService.purgeInstance(req.instance, {
        reason: 'manual',
        requestId: req.id,
        actorKeyId: req.auth.keyId,
      });
      ok(res, { instanceId: req.instance.id, ...result });
    },
  );

  /* ------------------------------ audit trail ----------------------------- */

  router.get(
    '/:instanceId/audit-events',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.auditRead),
    validate({ params: instanceIdParams, query: auditQuery }),
    loadInstance,
    async (req, res) => {
      const limit = Math.min(Number(req.valid.query.limit ?? 50), 200);
      const events = await audit.list({
        tenantId: req.instance.tenantId,
        instanceId: req.instance.id,
        limit,
      });
      const filtered = req.valid.query.action ? events.filter((event) => event.action === req.valid.query.action) : events;
      ok(res, { items: filtered }, { pagination: paginationMeta({ limit, hasMore: false, nextCursor: null, returned: filtered.length }) });
    },
  );

  /* -------------------------------- delete -------------------------------- */

  router.delete(
    '/:instanceId',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      const instanceId = req.instance.id;
      const result = await connectionService.deleteInstance(req.instance, {
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        ip: req.ip,
      });
      ok(res, {
        instanceId,
        deleted: true,
        purged: {
          messages: result.retention.messagesDeleted,
          webhookEvents: result.retention.webhookEventsDeleted,
          sessionDirectory: result.session.directoryRemoved,
          sessionArchive: result.session.archiveRemoved,
        },
      });
    },
  );

  return router;
}
