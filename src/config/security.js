/**
 * Static security policy: scopes, key formats, helmet/CORS policy and the
 * constants that middleware and services share.
 */

/** API key format: `wak_<keyId>_<secret>` where secret is 32 random bytes. */
export const API_KEY_PREFIX = 'wak';
export const API_KEY_ID_BYTES = 9; // 18 hex chars
export const API_KEY_SECRET_BYTES = 32; // 256 bits of entropy
export const API_KEY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes
export const API_KEY_ID_PATTERN = /^[a-f0-9]{18}$/;

/**
 * Granular API key scopes. `*` grants every scope.
 *
 * Ordinary RazorBills messaging uses `messages:send` only. Authentication
 * management (`auth:manage`) and credential management (`keys:manage`) are
 * owner-only and must not be granted to the RazorBills service key.
 */
export const SCOPES = Object.freeze({
  MESSAGES_SEND: 'messages:send',
  INSTANCES_READ: 'instances:read',
  CONNECTION_READ: 'connection:read',
  AUTH_MANAGE: 'auth:manage',
  KEYS_MANAGE: 'keys:manage',
  DATA_READ: 'data:read',
  AUDIT_READ: 'audit:read',
});

export const ALL_SCOPES = Object.freeze(Object.values(SCOPES));

/** Scopes that must never be handed to the ordinary RazorBills service key. */
export const OWNER_SCOPES = Object.freeze([SCOPES.AUTH_MANAGE, SCOPES.KEYS_MANAGE]);

/** Scope required by each route family. */
export const ROUTE_SCOPES = Object.freeze({
  // Read-only instance metadata and capabilities.
  instancesRead: [SCOPES.INSTANCES_READ],
  // Connection status and the live authentication event stream.
  connectionRead: [SCOPES.CONNECTION_READ],
  // Owner-only: instance lifecycle, QR/pairing, disconnect, session deletion.
  authManage: [SCOPES.AUTH_MANAGE],
  // Read-only retained chats/messages/contacts.
  dataRead: [SCOPES.DATA_READ],
  // Owner-only: API key administration.
  keysAdmin: [SCOPES.KEYS_MANAGE],
  auditRead: [SCOPES.AUDIT_READ],
  // Outbound messaging for the RazorBills backend.
  messagesSend: [SCOPES.MESSAGES_SEND],
});

/** Response headers used to signal rate limiting. */
export const RATE_LIMIT_HEADERS = Object.freeze({
  limit: 'ratelimit-limit',
  remaining: 'ratelimit-remaining',
  reset: 'ratelimit-reset',
  retryAfter: 'retry-after',
});

/** Helmet configuration: API service, no HTML rendering. */
export function helmetOptions() {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
  };
}

/**
 * Helmet configuration for the owner dashboard (ww2web) and its static assets.
 *
 * The API policy above is `default-src 'none'` because the API renders no HTML.
 * The dashboard is a same-origin single-page application, so it needs a
 * slightly wider policy — but no third-party origins are ever allowed:
 *   - scripts/styles/fonts come only from this service;
 *   - `img-src data:` is required to render QR challenges as data URLs;
 *   - `connect-src 'self'` covers the same-origin API and SSE stream.
 * Inline styles are permitted because Radix primitives position overlays with
 * inline `style` attributes; inline scripts are NOT.
 */
export function uiHelmetOptions() {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
  };
}

/** Known sensitive field names redacted from logs. */
export const LOG_REDACT_PATHS = Object.freeze([
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'apiKey',
  '*.apiKey',
  'csrfToken',
  '*.csrfToken',
  'password',
  '*.password',
  'token',
  '*.token',
  'pairingCode',
  '*.pairingCode',
  'qr',
  '*.qr',
  'qrDataUrl',
  '*.qrDataUrl',
  'sessionData',
  '*.sessionData',
  'cookies',
  '*.cookies',
]);

/**
 * Build the CORS origin callback for the configured allowlist.
 * Requests without an Origin header (server-to-server, curl) are always allowed.
 */
export function buildCorsOptions(config) {
  const { corsOrigins } = config.server;
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes('*')) return callback(null, config.isProduction ? false : true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Request-Id', 'Last-Event-ID'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  };
}
