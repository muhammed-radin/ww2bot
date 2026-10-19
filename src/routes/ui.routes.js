/**
 * Owner dashboard API (ww2web).
 *
 * These endpoints exist only to support the browser dashboard. They never
 * replace the versioned API — the dashboard calls the normal
 * `/api/v1/instances`, `/api/v1/api-keys`, … routes for everything they already
 * express — and they never return secret material.
 *
 * Authentication
 * --------------
 *  - `POST /ui/auth/login` exchanges an *owner* API key for a server-side
 *    session delivered as an HttpOnly cookie (see OwnerSessionService).
 *  - Everything else requires either that cookie or `X-API-Key`, plus the
 *    owner-only scopes, so the RazorBills messaging key can never reach it.
 *
 * CSRF
 * ----
 * The session cookie is an ambient credential, so state-changing requests
 * authenticated by it must present the per-session `X-CSRF-Token` header. That
 * check lives in the shared authenticator.
 */
import { Router } from 'express';
import { z } from 'zod';
import { OWNER_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { isStateChangingMethod, readCookie } from '../services/ownerSession.service.js';
import { UnauthorizedError } from '../utils/errors.js';
import { ok } from '../utils/respond.js';

const instanceId = z.string().regex(/^ins_[a-f0-9]{32}$/, 'must be a valid instance id');

const loginBody = z.object({
  apiKey: z.string().min(10).max(256),
});

const deliveriesQuery = z.object({
  instanceId: instanceId.optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

const auditQuery = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
  action: z.string().max(64).optional(),
  category: z.string().max(32).optional(),
  result: z.enum(['success', 'failure']).optional(),
  instanceId: instanceId.optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
});

export function createUiRouter({ config, ownerSessions, adminService, authenticate, requireScopes, rateLimit }) {
  const router = Router();
  const ownerOnly = [authenticate, requireScopes(...OWNER_SCOPES)];

  /**
   * Cookie-only guard for the session endpoints. Mirrors the shared
   * authenticator but refuses API keys: these routes describe the browser
   * session itself.
   */
  function ownerSessionOnly(req, res, next) {
    try {
      const session = ownerSessions.resolveFromRequest(req);
      if (!session) {
        res.clearCookie(ownerSessions.cookieName, ownerSessions.clearCookieOptions());
        throw new UnauthorizedError('No active owner session. Sign in to continue.');
      }
      req.ownerSession = session;
      req.auth = ownerSessions.authFor(session);
      if (isStateChangingMethod(req.method)) {
        ownerSessions.assertCsrf(session, req.get('x-csrf-token'));
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  /* ------------------------------- session ------------------------------- */

  router.post('/auth/login', rateLimit.login, validate({ body: loginBody }), async (req, res) => {
    const { token, csrfToken, owner, expiresAt } = await ownerSessions.login({
      apiKey: req.valid.body.apiKey,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    });

    res.cookie(ownerSessions.cookieName, token, ownerSessions.cookieOptions());
    ok(res, { owner, csrfToken, expiresAt });
  });

  router.get('/auth/session', ownerSessionOnly, async (req, res) => {
    ok(res, {
      owner: ownerSessions.ownerView(req.ownerSession),
      csrfToken: req.ownerSession.csrfToken,
      expiresAt: new Date(req.ownerSession.expiresAt).toISOString(),
    });
  });

  router.post('/auth/logout', ownerSessionOnly, async (req, res) => {
    const token = readCookie(req, ownerSessions.cookieName);
    const result = await ownerSessions.logout(token, { requestId: req.id, ip: req.ip });
    res.clearCookie(ownerSessions.cookieName, ownerSessions.clearCookieOptions());
    ok(res, { revoked: result.revoked });
  });

  /* ------------------------------- views --------------------------------- */

  router.get('/overview', ...ownerOnly, async (req, res) => {
    ok(res, await adminService.overview(req.auth));
  });

  router.get('/config', ...ownerOnly, async (req, res) => {
    ok(res, adminService.configView());
  });

  router.get('/connectors', ...ownerOnly, async (_req, res) => {
    ok(res, adminService.connectorView());
  });

  router.get(
    '/deliveries',
    ...ownerOnly,
    validate({ query: deliveriesQuery }),
    async (req, res) => {
      const { instanceId: target, limit } = req.valid.query;
      ok(res, await adminService.listDeliveries({ auth: req.auth, instanceId: target ?? null, limit: Number(limit ?? 50) }));
    },
  );

  router.get(
    '/audit-events',
    ...ownerOnly,
    validate({ query: auditQuery }),
    async (req, res) => {
      const query = req.valid.query;
      const result = await adminService.listAudit({
        auth: req.auth,
        instanceId: query.instanceId ?? null,
        action: query.action ?? null,
        category: query.category ?? null,
        result: query.result ?? null,
        since: query.since ?? null,
        until: query.until ?? null,
        limit: Number(query.limit ?? 50),
        offset: Number(query.offset ?? 0),
      });
      ok(res, { items: result.items }, { pagination: result.pagination });
    },
  );

  return router;
}
