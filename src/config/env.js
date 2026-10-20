/**
 * Environment configuration loader and validator.
 *
 * Responsibilities:
 *  - read process.env (or an explicitly supplied environment object)
 *  - validate + normalise every variable with zod
 *  - fail fast when the process is pointed at production with missing or
 *    insecurely configured secrets
 *
 * The returned object is deeply frozen: configuration is read-only at runtime.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/* -------------------------------------------------------------------------- */
/* zod helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** Boolean from env: "true"/"1"/"yes"/"on" => true, "false"/"0"/"no"/"off" => false. */
const bool = (fallback) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalised = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
    if (['false', '0', 'no', 'off'].includes(normalised)) return false;
    return value;
  }, z.boolean());

/** Integer from env with a fallback for unset/empty values. */
const num = (fallback, { min, max, int = true } = {}) => {
  let schema = z.coerce.number();
  if (int) schema = schema.int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? fallback : value),
    schema,
  );
};

/** Trimmed string with a fallback; empty string is treated as "unset". */
const str = (fallback = '') =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? fallback : value),
    z.string().trim(),
  );

/** Optional trimmed string: empty string becomes null. */
const optionalStr = () =>
  z.preprocess((value) => {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
  }, z.string().nullable());

/** Optional boolean: unset/empty becomes null (callers apply a context default). */
const optionalBool = () =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') return value;
    const normalised = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
    if (['false', '0', 'no', 'off'].includes(normalised)) return false;
    return value;
  }, z.boolean().nullable());

/* -------------------------------------------------------------------------- */
/* schema                                                                      */
/* -------------------------------------------------------------------------- */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: num(3000, { min: 1, max: 65535 }),
  HOST: str('0.0.0.0'),
  SERVICE_NAME: str('razorbills-whatsapp'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATA_DIR: str('./data'),
  DEFAULT_TENANT_ID: str('default'),

  API_KEY_PEPPER: optionalStr(),
  API_KEY_DEFAULT_TTL_DAYS: num(0, { min: 0, max: 3650 }),

  ENCRYPTION_KEY_PROVIDER: z.enum(['env', 'file']).default('env'),
  ENCRYPTION_KEY_ID: str('k1'),
  ENCRYPTION_KEYS: optionalStr(),
  ENCRYPTION_KEYS_FILE: optionalStr(),

  DEFAULT_CONNECTOR: z.enum(['cloud_api', 'web']).default('cloud_api'),

  META_ACCESS_TOKEN: optionalStr(),
  META_PHONE_NUMBER_ID: optionalStr(),
  META_VERIFY_TOKEN: optionalStr(),
  META_APP_SECRET: optionalStr(),
  META_API_VERSION: str('v21.0'),
  META_GRAPH_BASE_URL: str('https://graph.facebook.com'),

  ENABLE_WHATSAPP_WEB_CONNECTOR: bool(false),
  WHATSAPP_WEB_AUTHORIZATION_REFERENCE: optionalStr(),
  WHATSAPP_WEB_AUTH_STRATEGY: z.enum(['local', 'remote_encrypted']).default('local'),
  WHATSAPP_WEB_HEADLESS: bool(true),
  WHATSAPP_WEB_NO_SANDBOX: bool(false),
  WHATSAPP_WEB_PAIRING_INTERVAL_MS: num(180000, { min: 30000, max: 3600000 }),
  WHATSAPP_WEB_LAUNCH_TIMEOUT_MS: num(60000, { min: 10000, max: 600000 }),

  AUTO_RECONNECT_ON_STARTUP: bool(true),
  RECONNECT_ENABLED: bool(true),
  RECONNECT_BASE_DELAY_MS: num(2000, { min: 100, max: 600000 }),
  RECONNECT_MAX_DELAY_MS: num(300000, { min: 1000, max: 3600000 }),
  RECONNECT_MAX_ATTEMPTS: num(10, { min: 1, max: 1000 }),
  RECONNECT_MAX_DURATION_MS: num(900000, { min: 1000, max: 86400000 }),
  RECONNECT_JITTER: num(0.2, { min: 0, max: 1, int: false }),
  RECONNECT_STABLE_RESET_MS: num(60000, { min: 1000, max: 86400000 }),

  OUTBOUND_MESSAGING_ENABLED: bool(true),
  IDEMPOTENCY_TTL_MS: num(86400000, { min: 1000, max: 2592000000 }),
  DELIVERY_METADATA_RETENTION_DAYS: num(7, { min: 0, max: 3650 }),

  IP_ALLOWLIST: str(''),

  CORS_ORIGINS: str(''),
  TRUST_PROXY: str('false'),
  BODY_LIMIT: str('100kb'),
  // Raw media uploads (images, video, audio, documents, stickers) use a
  // dedicated octet-stream route. JSON bodies keep the strict BODY_LIMIT.
  MEDIA_MAX_BYTES: num(16777216, { min: 1024, max: 104857600 }),

  RATE_LIMIT_WINDOW_MS: num(60000, { min: 1000 }),
  RATE_LIMIT_MAX_REQUESTS: num(100, { min: 1 }),
  RATE_LIMIT_CONNECT_WINDOW_MS: num(60000, { min: 1000 }),
  RATE_LIMIT_CONNECT_MAX_REQUESTS: num(5, { min: 1 }),
  RATE_LIMIT_AUTH_WINDOW_MS: num(60000, { min: 1000 }),
  RATE_LIMIT_AUTH_MAX_REQUESTS: num(10, { min: 1 }),
  RATE_LIMIT_SEND_WINDOW_MS: num(60000, { min: 1000 }),
  RATE_LIMIT_SEND_MAX_REQUESTS: num(120, { min: 1 }),
  RATE_LIMIT_RECIPIENT_WINDOW_MS: num(60000, { min: 1000 }),
  RATE_LIMIT_RECIPIENT_MAX_REQUESTS: num(20, { min: 1 }),

  MAX_BROWSER_INSTANCES: num(3, { min: 1, max: 50 }),
  QR_TTL_MS: num(45000, { min: 5000, max: 300000 }),

  STREAM_TOKEN_TTL_MS: num(60000, { min: 5000, max: 900000 }),
  SSE_HEARTBEAT_MS: num(15000, { min: 1000, max: 60000 }),
  SSE_MAX_STREAM_MS: num(1800000, { min: 10000, max: 7200000 }),

  DEFAULT_PAGE_SIZE: num(25, { min: 1, max: 200 }),
  MAX_PAGE_SIZE: num(100, { min: 1, max: 500 }),
  RETAIN_MESSAGE_CONTENT: bool(false),
  DEFAULT_RETENTION_DAYS: num(7, { min: 0, max: 3650 }),
  MAX_RETENTION_DAYS: num(365, { min: 1, max: 3650 }),
  AUDIT_EVENTS_RETENTION_DAYS: num(90, { min: 1, max: 3650 }),

  SHUTDOWN_TIMEOUT_MS: num(15000, { min: 1000, max: 120000 }),

  // Owner administration dashboard (ww2web). These govern the server-side owner
  // session created when the owner signs in with an owner API key over the
  // browser. The session secret is derived from API_KEY_PEPPER, so no extra
  // secret material is required.
  OWNER_SESSION_TTL_MS: num(43200000, { min: 60000, max: 604800000 }),
  OWNER_SESSION_IDLE_MS: num(3600000, { min: 60000, max: 604800000 }),
  OWNER_SESSION_MAX: num(20, { min: 1, max: 1000 }),
  // Unset => Secure cookie in production, non-Secure otherwise (local http).
  OWNER_SESSION_COOKIE_SECURE: optionalBool(),
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'test',
  'please-change-me',
  'your-secret-here',
  'api-key-pepper',
]);

/** Parse TRUST_PROXY into a value Express understands. */
function parseTrustProxy(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback"
}

/** Parse the optional IP allowlist into normalised IPv4/IPv6 entries or CIDRs. */
export function parseIpAllowlist(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
}

/** Validate a base64-encoded AES-256 key. Returns the decoded length or throws. */
function base64KeyLength(value) {
  const decoded = Buffer.from(String(value), 'base64');
  return decoded.length;
}

/** Decode and validate the keyring from inline JSON or a keyring file. */
function resolveKeyRing({ provider, inline, file }) {
  const problems = [];
  let raw = null;
  let source = 'none';

  if (provider === 'file') {
    if (!file) {
      problems.push('ENCRYPTION_KEYS_FILE must be set when ENCRYPTION_KEY_PROVIDER=file');
      return { keys: {}, problems, source };
    }
    try {
      // Lazy import keeps this module usable in environments without fs access.
      // eslint-disable-next-line no-undef
      const { readFileSync } = globalThis.process.getBuiltinModule
        ? globalThis.process.getBuiltinModule('node:fs')
        : { readFileSync: null };
      if (!readFileSync) {
        problems.push('ENCRYPTION_KEYS_FILE is set but the filesystem module is unavailable');
        return { keys: {}, problems, source };
      }
      raw = readFileSync(file, 'utf8');
      source = `file:${file}`;
    } catch (error) {
      problems.push(`ENCRYPTION_KEYS_FILE could not be read: ${error.message}`);
      return { keys: {}, problems, source };
    }
  } else if (inline) {
    raw = inline;
    source = 'env:ENCRYPTION_KEYS';
  } else if (file) {
    return resolveKeyRing({ provider: 'file', inline: null, file });
  } else {
    return { keys: {}, problems, source };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('the encryption keyring must be valid JSON of shape {"keyId":"<base64 32 bytes>"}');
    return { keys: {}, problems, source };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('the encryption keyring must be a JSON object mapping key ids to base64 keys');
    return { keys: {}, problems, source };
  }

  const keys = {};
  for (const [keyId, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      problems.push(`encryption key "${keyId}" must be a base64 string`);
      continue;
    }
    const length = base64KeyLength(value);
    if (length !== 32) {
      problems.push(`encryption key "${keyId}" must decode to exactly 32 bytes (got ${length})`);
      continue;
    }
    keys[keyId] = value;
  }
  if (Object.keys(keys).length === 0 && problems.length === 0) {
    problems.push('the encryption keyring is empty');
  }
  return { keys, problems, source };
}

/* -------------------------------------------------------------------------- */
/* loader                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Load, validate and freeze the application configuration.
 * @param {Record<string, string|undefined>} [rawEnv] Environment to read. When
 *   omitted, `.env` is loaded and `process.env` is used.
 */
export function loadConfig(rawEnv) {
  const useProcessEnv = rawEnv === undefined;
  if (useProcessEnv) {
    try {
      dotenv.config({ quiet: true });
    } catch {
      /* dotenv is optional at runtime */
    }
  }
  const source = rawEnv ?? process.env;
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(problems);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const problems = [];
  const warnings = [];

  /* ----------------------------- pepper ---------------------------------- */
  let apiKeyPepper = env.API_KEY_PEPPER;
  let ephemeralApiKeyPepper = false;
  if (apiKeyPepper) {
    if (apiKeyPepper.length < 32) {
      problems.push('API_KEY_PEPPER must be at least 32 characters long');
    }
    if (PLACEHOLDER_SECRETS.has(apiKeyPepper.toLowerCase())) {
      problems.push('API_KEY_PEPPER is a well-known placeholder value');
    }
  } else if (isProduction) {
    problems.push('API_KEY_PEPPER is required in production');
  } else {
    apiKeyPepper = crypto.randomBytes(48).toString('base64');
    ephemeralApiKeyPepper = true;
    warnings.push('API_KEY_PEPPER is unset: using an ephemeral development pepper (restart invalidates existing keys)');
  }

  /* --------------------------- encryption -------------------------------- */
  const keyRing = resolveKeyRing({
    provider: env.ENCRYPTION_KEY_PROVIDER,
    inline: env.ENCRYPTION_KEYS,
    file: env.ENCRYPTION_KEYS_FILE,
  });
  problems.push(...keyRing.problems);
  let encryptionKeys = keyRing.keys;
  let ephemeralEncryptionKey = false;
  if (isProduction && Object.keys(encryptionKeys).length === 0 && keyRing.problems.length === 0) {
    problems.push(
      'an encryption keyring is required in production: set ENCRYPTION_KEYS (or ENCRYPTION_KEYS_FILE for ENCRYPTION_KEY_PROVIDER=file)',
    );
  }
  if (Object.keys(encryptionKeys).length === 0 && !isProduction && keyRing.problems.length === 0) {
    encryptionKeys = { [env.ENCRYPTION_KEY_ID]: crypto.randomBytes(32).toString('base64') };
    ephemeralEncryptionKey = true;
    warnings.push(
      'no encryption keyring configured: using an ephemeral development key (stored ciphertext cannot be read after restart)',
    );
  }
  if (Object.keys(encryptionKeys).length > 0 && !encryptionKeys[env.ENCRYPTION_KEY_ID]) {
    problems.push(
      `ENCRYPTION_KEY_ID "${env.ENCRYPTION_KEY_ID}" is not present in the configured keyring (available: ${Object.keys(
        encryptionKeys,
      ).join(', ') || 'none'})`,
    );
  }

  /* ------------------------------- CORS ---------------------------------- */
  const corsOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];
  if (corsOrigins.includes('*')) {
    if (isProduction) problems.push('CORS_ORIGINS must not contain "*" in production');
    else warnings.push('CORS_ORIGINS contains "*": unrestricted cross-origin access is allowed in development only');
  }
  if (isProduction && corsOrigins.length === 0) {
    problems.push('CORS_ORIGINS must list at least one allowed origin in production');
  }

  /* --------------------------- datastores -------------------------------- */
  if (isProduction && env.DATA_DIR === './data') {
    warnings.push(
      'DATA_DIR is the default "./data": make sure it points at a persistent, access-restricted volume ' +
        'so WhatsApp sessions survive restarts and redeployments',
    );
  }

  /* ------------------------ reconnection policy --------------------------- */
  if (env.RECONNECT_BASE_DELAY_MS > env.RECONNECT_MAX_DELAY_MS) {
    problems.push('RECONNECT_BASE_DELAY_MS must not exceed RECONNECT_MAX_DELAY_MS');
  }

  /* --------------------------- messaging ---------------------------------- */
  if (env.DELIVERY_METADATA_RETENTION_DAYS === 0 && env.OUTBOUND_MESSAGING_ENABLED) {
    warnings.push(
      'DELIVERY_METADATA_RETENTION_DAYS=0 disables delivery metadata: idempotency of outbound sends is lost (records are pruned immediately)',
    );
  }

  /* ---------------------------- Cloud API -------------------------------- */
  if (env.META_ACCESS_TOKEN && !env.META_PHONE_NUMBER_ID) {
    problems.push('META_PHONE_NUMBER_ID is required when META_ACCESS_TOKEN is set');
  }
  if (env.META_PHONE_NUMBER_ID && !env.META_ACCESS_TOKEN) {
    problems.push('META_ACCESS_TOKEN is required when META_PHONE_NUMBER_ID is set');
  }
  if (env.META_VERIFY_TOKEN && !env.META_APP_SECRET) {
    problems.push('META_APP_SECRET is required when META_VERIFY_TOKEN is set (webhook signature verification)');
  }

  /* ---------------------------- Web connector ----------------------------- */
  if (env.ENABLE_WHATSAPP_WEB_CONNECTOR && !env.WHATSAPP_WEB_AUTHORIZATION_REFERENCE) {
    problems.push(
      'ENABLE_WHATSAPP_WEB_CONNECTOR=true requires WHATSAPP_WEB_AUTHORIZATION_REFERENCE ' +
        '(a reference to the written authorization you hold for this exact use)',
    );
  }
  if (!env.ENABLE_WHATSAPP_WEB_CONNECTOR && env.WHATSAPP_WEB_AUTHORIZATION_REFERENCE) {
    warnings.push('WHATSAPP_WEB_AUTHORIZATION_REFERENCE is set while the web connector stays disabled; no effect');
  }
  if (env.DEFAULT_CONNECTOR === 'web' && !env.ENABLE_WHATSAPP_WEB_CONNECTOR) {
    problems.push('DEFAULT_CONNECTOR=web requires ENABLE_WHATSAPP_WEB_CONNECTOR=true');
  }
  if (isProduction && env.ENABLE_WHATSAPP_WEB_CONNECTOR && env.WHATSAPP_WEB_AUTH_STRATEGY === 'local') {
    warnings.push(
      'WHATSAPP_WEB_AUTH_STRATEGY=local stores browser profiles unencrypted on disk; ' +
        'use "remote_encrypted" or an encrypted volume, and document the storage mechanism',
    );
  }
  if (env.ENABLE_WHATSAPP_WEB_CONNECTOR && env.WHATSAPP_WEB_NO_SANDBOX) {
    warnings.push(
      'WHATSAPP_WEB_NO_SANDBOX=true disables Chromium\'s sandbox. Use it only on hosts where ' +
        'unprivileged user namespaces are unavailable (for example local development), never as a default.',
    );
  }

  /* --------------------------- pagination -------------------------------- */
  if (env.DEFAULT_PAGE_SIZE > env.MAX_PAGE_SIZE) {
    problems.push('DEFAULT_PAGE_SIZE must not exceed MAX_PAGE_SIZE');
  }
  if (env.DEFAULT_RETENTION_DAYS > env.MAX_RETENTION_DAYS) {
    problems.push('DEFAULT_RETENTION_DAYS must not exceed MAX_RETENTION_DAYS');
  }
  if (env.RETAIN_MESSAGE_CONTENT && env.DEFAULT_RETENTION_DAYS === 0) {
    problems.push('DEFAULT_RETENTION_DAYS must be greater than 0 when RETAIN_MESSAGE_CONTENT=true');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const config = {
    env: env.NODE_ENV,
    isProduction,
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    serviceName: env.SERVICE_NAME,
    logLevel: env.LOG_LEVEL,
    warnings,

    media: {
      maxUploadBytes: env.MEDIA_MAX_BYTES,
    },

    server: {
      port: env.PORT,
      host: env.HOST,
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      bodyLimit: env.BODY_LIMIT,
      corsOrigins,
      ipAllowlist: parseIpAllowlist(env.IP_ALLOWLIST),
      rateLimit: {
        default: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX_REQUESTS },
        connect: { windowMs: env.RATE_LIMIT_CONNECT_WINDOW_MS, max: env.RATE_LIMIT_CONNECT_MAX_REQUESTS },
        auth: { windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS, max: env.RATE_LIMIT_AUTH_MAX_REQUESTS },
        send: { windowMs: env.RATE_LIMIT_SEND_WINDOW_MS, max: env.RATE_LIMIT_SEND_MAX_REQUESTS },
        recipient: { windowMs: env.RATE_LIMIT_RECIPIENT_WINDOW_MS, max: env.RATE_LIMIT_RECIPIENT_MAX_REQUESTS },
      },
    },

    data: {
      dir: env.DATA_DIR,
    },

    reconnect: {
      enabled: env.RECONNECT_ENABLED,
      onStartup: env.AUTO_RECONNECT_ON_STARTUP,
      baseDelayMs: env.RECONNECT_BASE_DELAY_MS,
      maxDelayMs: env.RECONNECT_MAX_DELAY_MS,
      maxAttempts: env.RECONNECT_MAX_ATTEMPTS,
      maxDurationMs: env.RECONNECT_MAX_DURATION_MS,
      jitter: env.RECONNECT_JITTER,
      stableResetMs: env.RECONNECT_STABLE_RESET_MS,
    },

    outbound: {
      enabled: env.OUTBOUND_MESSAGING_ENABLED,
      idempotencyTtlMs: env.IDEMPOTENCY_TTL_MS,
      deliveryRetentionDays: env.DELIVERY_METADATA_RETENTION_DAYS,
    },

    defaultTenantId: env.DEFAULT_TENANT_ID,

    security: {
      apiKeyPepper,
      ephemeralApiKeyPepper,
      apiKeyDefaultTtlDays: env.API_KEY_DEFAULT_TTL_DAYS,
    },

    encryption: {
      provider: env.ENCRYPTION_KEY_PROVIDER,
      activeKeyId: env.ENCRYPTION_KEY_ID,
      keys: encryptionKeys,
      ephemeral: ephemeralEncryptionKey,
      source: keyRing.source,
    },

    connectors: {
      default: env.DEFAULT_CONNECTOR,
      cloud: {
        accessToken: env.META_ACCESS_TOKEN,
        phoneNumberId: env.META_PHONE_NUMBER_ID,
        verifyToken: env.META_VERIFY_TOKEN,
        appSecret: env.META_APP_SECRET,
        apiVersion: env.META_API_VERSION,
        graphBaseUrl: env.META_GRAPH_BASE_URL,
        configured: Boolean(env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID),
        webhooksEnabled: Boolean(env.META_VERIFY_TOKEN && env.META_APP_SECRET),
      },
      web: {
        enabled: env.ENABLE_WHATSAPP_WEB_CONNECTOR,
        authorizationReference: env.WHATSAPP_WEB_AUTHORIZATION_REFERENCE,
        authStrategy: env.WHATSAPP_WEB_AUTH_STRATEGY,
        headless: env.WHATSAPP_WEB_HEADLESS,
        noSandbox: env.WHATSAPP_WEB_NO_SANDBOX,
        pairingIntervalMs: env.WHATSAPP_WEB_PAIRING_INTERVAL_MS,
        launchTimeoutMs: env.WHATSAPP_WEB_LAUNCH_TIMEOUT_MS,
        maxInstances: env.MAX_BROWSER_INSTANCES,
      },
    },

    limits: {
      maxBrowserInstances: env.MAX_BROWSER_INSTANCES,
      qrTtlMs: env.QR_TTL_MS,
    },

    events: {
      streamTokenTtlMs: env.STREAM_TOKEN_TTL_MS,
      heartbeatMs: env.SSE_HEARTBEAT_MS,
      maxStreamMs: env.SSE_MAX_STREAM_MS,
    },

    pagination: {
      defaultPageSize: env.DEFAULT_PAGE_SIZE,
      maxPageSize: env.MAX_PAGE_SIZE,
    },

    retention: {
      retainMessageContent: env.RETAIN_MESSAGE_CONTENT,
      defaultDays: env.DEFAULT_RETENTION_DAYS,
      maxDays: env.MAX_RETENTION_DAYS,
      auditDays: env.AUDIT_EVENTS_RETENTION_DAYS,
    },

    shutdown: {
      timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    },

    ownerSession: {
      // Absolute lifetime and sliding idle timeout for an owner browser session.
      ttlMs: env.OWNER_SESSION_TTL_MS,
      idleMs: Math.min(env.OWNER_SESSION_IDLE_MS, env.OWNER_SESSION_TTL_MS),
      maxSessions: env.OWNER_SESSION_MAX,
      // Secure cookies require HTTPS; the dashboard is same-origin, so
      // SameSite=Strict is safe. Production defaults to Secure.
      cookieSecure: env.OWNER_SESSION_COOKIE_SECURE ?? isProduction,
      cookieName: 'ww2_owner_session',
    },
  };

  return deepFreeze(config);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
