/**
 * Request identifier middleware.
 *
 * A tracing id is accepted from the client (bounded and sanitised) or
 * generated. It is echoed in the `X-Request-Id` response header and included in
 * every error body so a report can be tied to server logs.
 */
import crypto from 'node:crypto';

const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

export function requestIdMiddleware(req, res, next) {
  const provided = req.get('x-request-id');
  const id = typeof provided === 'string' && REQUEST_ID_PATTERN.test(provided) ? provided : `req_${crypto.randomUUID().replace(/-/g, '')}`;
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function getRequestId(req) {
  return req.id ?? req.get?.('x-request-id') ?? 'unknown';
}
