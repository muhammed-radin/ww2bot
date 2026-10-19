/**
 * Structured logging with mandatory redaction.
 *
 * Anything that could be an authentication credential (API keys, QR payloads,
 * pairing codes, cookies, session material) is redacted before a line is
 * written. Message bodies and phone numbers are never logged by callers; the
 * redaction list is the safety net, not the primary defence.
 */
import crypto from 'node:crypto';
import pino from 'pino';
import { LOG_REDACT_PATHS } from '../config/security.js';

export function createLogger(config, overrides = {}) {
  const { destination, ...options } = overrides;
  const logger = {
    name: config.serviceName,
    level: config.logLevel,
    base: {
      env: config.env,
      pid: process.pid,
      service: config.serviceName,
    },
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...options,
  };
  // A destination stream is useful for tests that assert on redaction.
  return destination ? pino(logger, destination) : pino(logger);
}

/**
 * Express request logger. Never logs request bodies or headers verbatim, and
 * links every line to the request id used in API error responses.
 */
export function createHttpLogger(config, logger) {
  return {
    logger,
    genReqId(req, res) {
      const headerId = req.headers['x-request-id'];
      const id = typeof headerId === 'string' && /^[\w.:-]{1,128}$/.test(headerId) ? headerId : newRequestId();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel(_req, res, error) {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage(req, res) {
      return `request completed ${req.method} ${sanitiseUrl(req.originalUrl)} -> ${res.statusCode}`;
    },
    customErrorMessage(req, res, error) {
      return `request failed ${req.method} ${sanitiseUrl(req.originalUrl)} -> ${res.statusCode}`;
    },
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: sanitiseUrl(req.url) };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
    autoLogging: {
      ignore: (req) => req.url === '/health/live' || req.url.startsWith('/health/live?'),
    },
  };
}

function newRequestId() {
  return `req_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Strip query strings and path segments that could carry credentials. */
export function sanitiseUrl(url) {
  if (typeof url !== 'string') return url;
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  // Some tokens are legitimately carried in the query string (single-use SSE
  // stream tokens). Never write their value to the log file.
  if (queryIndex === -1) return path;
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  for (const key of ['streamToken', 'stream_token', 'token', 'api_key', 'apiKey', 'key']) {
    if (params.has(key)) params.set(key, '[REDACTED]');
  }
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}
