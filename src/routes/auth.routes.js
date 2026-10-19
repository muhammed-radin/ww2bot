/**
 * Real-time authentication and connection event stream (Server-Sent Events).
 *
 * Authorisation:
 *  - the API key may be sent in the `X-API-Key` header (streaming fetch), or
 *  - the client exchanges its key for a single-use stream token at
 *    POST /stream-token and passes it as `?streamToken=`.
 *    A long-lived API key is never accepted in the URL.
 *
 * Hardening: one connection per subscriber is registered with the event bus and
 * removed on close; a heartbeat keeps intermediaries from idling the connection
 * out; the stream is closed after SSE_MAX_STREAM_MS; and the number of
 * concurrent streams per instance is capped.
 */
import { Router } from 'express';
import { ROUTE_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { ErrorCode, RateLimitError, UnauthorizedError } from '../utils/errors.js';
import { instanceIdParams } from '../validators/instance.validator.js';
import { ok } from '../utils/respond.js';

const MAX_STREAMS_PER_INSTANCE = 10;

export function createAuthRouter({
  config,
  apiKeyService,
  streamTokens,
  connectionEvents,
  connectionService = null,
  authenticate,
  requireScopes,
  rateLimit,
  loadInstance,
  ownerSessions = null,
}) {
  const router = Router({ mergeParams: true });

  /* --------------------------- stream token ------------------------------ */

  router.post(
    '/stream-token',
    rateLimit.auth,
    authenticate,
    requireScopes(...ROUTE_SCOPES.connectionRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      const issued = await streamTokens.issue({ auth: req.auth, instanceId: req.instance.id });
      ok(res, {
        ...issued,
        // Documented usage: connect with
        // `new EventSource(`${base}/api/v1/instances/${id}/auth/events?streamToken=${token}`)`
        eventsEndpoint: `/api/v1/instances/${req.instance.id}/auth/events`,
        singleUse: true,
        note: 'The token is single-use, bound to this instance, and expires shortly.',
      });
    },
  );

  /* --------------------------- event stream ------------------------------ */

  router.get(
    '/events',
    validate({ params: instanceIdParams }),
    authenticateEventStream({ apiKeyService, streamTokens, ownerSessions }),
    requireScopes(...ROUTE_SCOPES.connectionRead),
    loadInstance,
    async (req, res) => {
      if (connectionEvents.listenerCount(req.instance.id) >= MAX_STREAMS_PER_INSTANCE) {
        throw new RateLimitError('Too many concurrent event streams for this instance.', {
          limit: MAX_STREAMS_PER_INSTANCE,
        });
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Disable proxy buffering so events arrive immediately.
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const write = (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      };

      write(`retry: 5000\n\n`);

      // A late subscriber should not start blind: include a status snapshot so a
      // page opened mid-session immediately shows the current phase (for example
      // post-authentication sync progress) before the next live event arrives.
      let snapshot = null;
      try {
        snapshot = connectionService ? await connectionService.getStatus(req.instance) : null;
      } catch {
        snapshot = null;
      }

      write(
        `event: stream.ready\ndata: ${JSON.stringify({
          instanceId: req.instance.id,
          connector: req.instance.connector,
          at: new Date().toISOString(),
          snapshot,
        })}\n\n`,
      );

      const unsubscribe = await connectionEvents.subscribe(req.instance.id, (event) => {
        write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`);
      });

      const heartbeat = setInterval(() => {
        write(`: heartbeat ${Date.now()}\n\n`);
      }, config.events.heartbeatMs);
      heartbeat.unref?.();

      const maxTimer = setTimeout(() => {
        write(`event: stream.closed\ndata: ${JSON.stringify({ reason: 'max_duration_reached' })}\n\n`);
        cleanup();
        res.end();
      }, config.events.maxStreamMs);
      maxTimer.unref?.();

      let closed = false;
      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(maxTimer);
        Promise.resolve(unsubscribe()).catch(() => {});
      }

      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
    },
  );

  return router;
}

/**
 * Accept an API key header, an owner session cookie, or a single-use stream
 * token in the query. A stream token is additionally checked against the
 * instance in the path.
 */
function authenticateEventStream({ apiKeyService, streamTokens, ownerSessions = null }) {
  return async function authenticateEventStreamMiddleware(req, _res, next) {
    try {
      const header = req.get('x-api-key');
      if (header) {
        req.auth = await apiKeyService.verify(header, { requestId: req.id, ip: req.ip });
        return next();
      }

      // Owner dashboard: the session cookie authorises the stream directly, so
      // the browser needs no stream token. EventSource sends same-origin cookies.
      if (ownerSessions) {
        const session = ownerSessions.resolveFromRequest(req);
        if (session) {
          req.ownerSession = session;
          req.auth = ownerSessions.authFor(session);
          return next();
        }
      }

      const token = req.query.streamToken;
      if (typeof token !== 'string' || token === '') {
        throw new UnauthorizedError('Provide the X-API-Key header, an owner session cookie, or a single-use streamToken query parameter.');
      }

      const bound = await streamTokens.consume(token);
      if (bound.instanceId !== req.params.instanceId) {
        throw new UnauthorizedError('The stream token is not valid for this instance.', {
          code: ErrorCode.INVALID_STREAM_TOKEN,
        });
      }
      req.auth = bound;
      req.streamTokenUsed = true;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
