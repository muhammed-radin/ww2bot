/**
 * Request authentication.
 *
 * Two credentials are accepted, in this order:
 *
 *  1. An **owner dashboard session** cookie (HttpOnly, SameSite=Strict). It is
 *     issued by the owner login endpoint after the owner presents an owner API
 *     key, and it is honoured here so the browser can call the normal API
 *     without ever holding a key. State-changing requests authenticated this way
 *     must also present the session CSRF token.
 *  2. The **X-API-Key** header. The key is read exclusively from the header, so
 *     keys never end up in access logs, referrers or browser history.
 *
 * Scope checks are explicit and the resulting authorisation context is attached
 * to `req.auth` (with `source: 'session' | 'api_key'`).
 */
import { ApiKeyService } from '../services/apiKey.service.js';
import { isStateChangingMethod, readCookie } from '../services/ownerSession.service.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { SCOPES } from '../config/security.js';

export function createApiKeyAuth({ apiKeyService, audit, ownerSessions = null }) {
  /** Authenticate the caller and attach `req.auth`. */
  async function authenticate(req, res, next) {
    try {
      // 1. Owner dashboard session takes precedence when a usable cookie exists.
      if (ownerSessions) {
        const session = ownerSessions.resolveFromRequest(req);
        if (session) {
          req.ownerSession = session;
          req.auth = ownerSessions.authFor(session);

          // A cookie is an ambient credential: state-changing requests must
          // carry the matching per-session CSRF token.
          if (isStateChangingMethod(req.method)) {
            ownerSessions.assertCsrf(session, req.get('x-csrf-token'));
          }

          await audit?.record({
            action: 'auth.success',
            result: 'success',
            tenantId: req.auth.tenantId,
            requestId: req.id,
            actorKeyId: req.auth.keyId,
            ip: req.ip,
            metadata: { method: req.method, path: req.path, via: 'session' },
          });

          return next();
        }

        // A stale/expired cookie should not be sent forever; clear it.
        if (typeof res?.clearCookie === 'function' && readCookie(req, ownerSessions.cookieName)) {
          res.clearCookie(ownerSessions.cookieName, ownerSessions.clearCookieOptions());
        }
      }

      // 2. API key from the X-API-Key header.
      const header = req.get('x-api-key');
      if (!header) {
        await audit?.record({
          action: 'auth.missing_api_key',
          result: 'failure',
          requestId: req.id,
          ip: req.ip,
          metadata: { method: req.method, path: req.path },
        });
        throw new UnauthorizedError('The X-API-Key header is required.');
      }

      const auth = await apiKeyService.verify(header, { requestId: req.id, ip: req.ip });
      req.auth = { ...auth, source: 'api_key' };

      // Best-effort success audit; never audit the key value itself.
      await audit?.record({
        action: 'auth.success',
        result: 'success',
        tenantId: auth.tenantId,
        requestId: req.id,
        actorKeyId: auth.keyId,
        ip: req.ip,
        metadata: { method: req.method, path: req.path, via: 'api_key' },
      });

      next();
    } catch (error) {
      next(error);
    }
  }

  /** Require at least one of the given scopes once `authenticate` has run. */
  function requireScopes(...scopes) {
    return (req, _res, next) => {
      try {
        if (!req.auth) throw new UnauthorizedError('A valid API key is required.');
        const missing = scopes.filter((scope) => !ApiKeyService.hasScope(req.auth, scope));
        if (missing.length > 0) {
          throw new ForbiddenError('The API key is missing a required scope.', { missingScopes: missing });
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  return { authenticate, requireScopes, SCOPES };
}
