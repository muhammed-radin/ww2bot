import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../src/config/env.js';

const keys = JSON.stringify({ k1: Buffer.alloc(32, 3).toString('base64') });

const productionEnv = {
  NODE_ENV: 'production',
  DATA_DIR: '/var/lib/razorbills-whatsapp',
  API_KEY_PEPPER: 'a-production-pepper-that-is-long-enough-1234',
  ENCRYPTION_KEY_PROVIDER: 'env',
  ENCRYPTION_KEY_ID: 'k1',
  ENCRYPTION_KEYS: keys,
  CORS_ORIGINS: 'https://app.example.com',
};

function expectConfigError(env, fragment) {
  assert.throws(
    () => loadConfig(env),
    (error) => {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
      assert.match(error.message, new RegExp(fragment), `expected message to mention ${fragment}`);
      return true;
    },
  );
}

test('development configuration produces safe defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.server.port, 3000);
  assert.equal(config.server.trustProxy, false);
  assert.equal(config.connectors.default, 'cloud_api');
  assert.equal(config.connectors.web.enabled, false);
  assert.equal(config.retention.retainMessageContent, false);
  assert.equal(config.pagination.defaultPageSize, 25);
  assert.equal(config.pagination.maxPageSize, 100);
  // Without a configured pepper or key ring, development gets ephemeral ones.
  assert.equal(config.security.ephemeralApiKeyPepper, true);
  assert.equal(config.encryption.ephemeral, true);
  assert.ok(config.security.apiKeyPepper.length >= 32);
  assert.deepEqual(Object.keys(config.encryption.keys), ['k1']);
  assert.ok(config.warnings.some((warning) => warning.includes('API_KEY_PEPPER')));
});

test('a valid production configuration loads and is deeply frozen', () => {
  const config = loadConfig(productionEnv);
  assert.equal(config.isProduction, true);
  assert.equal(config.security.ephemeralApiKeyPepper, false);
  assert.equal(config.encryption.ephemeral, false);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.connectors.web));
  assert.throws(() => {
    config.server.port = 1;
  }, TypeError);
});

test('production fails fast when required secrets are missing', () => {
  expectConfigError({ ...productionEnv, API_KEY_PEPPER: '' }, 'API_KEY_PEPPER is required in production');
  expectConfigError({ ...productionEnv, CORS_ORIGINS: '' }, 'CORS_ORIGINS must list at least one allowed origin');
  expectConfigError({ ...productionEnv, ENCRYPTION_KEYS: '', ENCRYPTION_KEYS_FILE: '' }, 'encryption');
});

test('data directory defaults to ./data and is validated', () => {
  const development = loadConfig({ NODE_ENV: 'development' });
  assert.equal(development.data.dir, './data');

  // Production pointed at the default directory is allowed but flagged.
  const flagged = loadConfig({ ...productionEnv, DATA_DIR: './data' });
  assert.ok(flagged.warnings.some((warning) => warning.includes('DATA_DIR')));

  const explicit = loadConfig({ ...productionEnv, DATA_DIR: '/srv/data' });
  assert.equal(explicit.data.dir, '/srv/data');
  assert.ok(!explicit.warnings.some((warning) => warning.includes('DATA_DIR')));
});

test('insecure secrets are rejected', () => {
  expectConfigError({ ...productionEnv, API_KEY_PEPPER: 'short' }, 'at least 32 characters');
  expectConfigError({ ...productionEnv, API_KEY_PEPPER: 'changeme' }, 'placeholder');
  expectConfigError({ ...productionEnv, CORS_ORIGINS: '*' }, 'must not contain');
  expectConfigError(
    { ...productionEnv, ENCRYPTION_KEYS: JSON.stringify({ k1: Buffer.alloc(16, 1).toString('base64') }) },
    'exactly 32 bytes',
  );
  expectConfigError(
    { ...productionEnv, ENCRYPTION_KEYS: JSON.stringify({ k2: Buffer.alloc(32, 1).toString('base64') }) },
    'not present in the configured keyring',
  );
  expectConfigError({ ...productionEnv, ENCRYPTION_KEYS: 'not json' }, 'valid JSON');
});

test('the web connector requires an explicit authorization reference', () => {
  expectConfigError(
    { ...productionEnv, ENABLE_WHATSAPP_WEB_CONNECTOR: 'true' },
    'requires WHATSAPP_WEB_AUTHORIZATION_REFERENCE',
  );

  const config = loadConfig({
    ...productionEnv,
    ENABLE_WHATSAPP_WEB_CONNECTOR: 'true',
    WHATSAPP_WEB_AUTHORIZATION_REFERENCE: 'AUTHZ-2026-001',
  });
  assert.equal(config.connectors.web.enabled, true);
  assert.equal(config.connectors.web.authorizationReference, 'AUTHZ-2026-001');
});

test('the web connector cannot be the default while disabled', () => {
  expectConfigError(
    { ...productionEnv, DEFAULT_CONNECTOR: 'web', ENABLE_WHATSAPP_WEB_CONNECTOR: 'false' },
    'DEFAULT_CONNECTOR=web requires',
  );
});

test('cloud api credentials must be complete and webhooks verifiable', () => {
  expectConfigError({ ...productionEnv, META_ACCESS_TOKEN: 'token' }, 'META_PHONE_NUMBER_ID is required');
  expectConfigError({ ...productionEnv, META_PHONE_NUMBER_ID: '123' }, 'META_ACCESS_TOKEN is required');
  expectConfigError({ ...productionEnv, META_VERIFY_TOKEN: 'verify' }, 'META_APP_SECRET is required');
});

test('retention and pagination bounds are consistent', () => {
  expectConfigError(
    { ...productionEnv, RETAIN_MESSAGE_CONTENT: 'true', DEFAULT_RETENTION_DAYS: '0' },
    'DEFAULT_RETENTION_DAYS must be greater than 0',
  );
  expectConfigError(
    { ...productionEnv, DEFAULT_PAGE_SIZE: '200', MAX_PAGE_SIZE: '100' },
    'DEFAULT_PAGE_SIZE must not exceed MAX_PAGE_SIZE',
  );
});

test('invalid values fail with a clear problem list', () => {
  expectConfigError({ NODE_ENV: 'development', PORT: '70000' }, 'PORT');
  expectConfigError({ NODE_ENV: 'development', PORT: 'not-a-number' }, 'PORT');
  expectConfigError({ NODE_ENV: 'development', LOG_LEVEL: 'verbose' }, 'LOG_LEVEL');
  expectConfigError({ NODE_ENV: 'development', RECONNECT_BASE_DELAY_MS: 'not-a-number' }, 'RECONNECT_BASE_DELAY_MS');
});

test('environment values are parsed, not just passed through', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    AUTO_RECONNECT_ON_STARTUP: 'yes',
    ENABLE_WHATSAPP_WEB_CONNECTOR: '1',
    WHATSAPP_WEB_AUTHORIZATION_REFERENCE: 'ref',
    TRUST_PROXY: '2',
    CORS_ORIGINS: 'https://a.example.com, https://b.example.com',
    RATE_LIMIT_MAX_REQUESTS: '42',
    IP_ALLOWLIST: '10.0.0.0/8, 127.0.0.1',
  });
  assert.equal(config.reconnect.onStartup, true);
  assert.equal(config.connectors.web.enabled, true);
  assert.equal(config.server.trustProxy, 2);
  assert.deepEqual(config.server.corsOrigins, ['https://a.example.com', 'https://b.example.com']);
  assert.deepEqual(config.server.ipAllowlist, ['10.0.0.0/8', '127.0.0.1']);
  assert.equal(config.server.rateLimit.default.max, 42);

  const loopback = loadConfig({ NODE_ENV: 'development', TRUST_PROXY: 'loopback' });
  assert.equal(loopback.server.trustProxy, 'loopback');
});

test('a local (unencrypted-profile) web connector in production is flagged', () => {
  const config = loadConfig({
    ...productionEnv,
    ENABLE_WHATSAPP_WEB_CONNECTOR: 'true',
    WHATSAPP_WEB_AUTHORIZATION_REFERENCE: 'AUTHZ-1',
    WHATSAPP_WEB_AUTH_STRATEGY: 'local',
  });
  assert.ok(config.warnings.some((warning) => warning.includes('unencrypted')));
});
