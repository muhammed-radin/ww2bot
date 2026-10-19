/**
 * Test harness: builds an isolated application instance per test file.
 *
 * Every test runs against a real, temporary `DATA_DIR`, so the file-backed
 * repositories, atomic writes, locking and corruption handling are all
 * exercised — not a look-alike. The WhatsApp Web library is replaced by a fake
 * module so the real connector code paths (options building, event wiring,
 * session directories) run without a browser or a real account.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { createContainer } from '../../src/container.js';
import { createApp } from '../../src/app.js';

export const TEST_PEPPER = 'unit-test-pepper-value-0123456789abcdefghijklmnop';
export const TEST_KEY_RING = { k1: Buffer.alloc(32, 7).toString('base64') };

export const BASE_TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_KEY_PEPPER: TEST_PEPPER,
  ENCRYPTION_KEY_PROVIDER: 'env',
  ENCRYPTION_KEY_ID: 'k1',
  ENCRYPTION_KEYS: JSON.stringify(TEST_KEY_RING),
  CORS_ORIGINS: 'https://app.example.test',
  // Generous limits by default; individual tests override these.
  RATE_LIMIT_MAX_REQUESTS: '10000',
  RATE_LIMIT_CONNECT_MAX_REQUESTS: '10000',
  RATE_LIMIT_AUTH_MAX_REQUESTS: '10000',
  RATE_LIMIT_SEND_MAX_REQUESTS: '10000',
  RATE_LIMIT_RECIPIENT_MAX_REQUESTS: '10000',
  ENABLE_WHATSAPP_WEB_CONNECTOR: 'true',
  WHATSAPP_WEB_AUTHORIZATION_REFERENCE: 'TEST-AUTHZ-REFERENCE-0001',
  WHATSAPP_WEB_AUTH_STRATEGY: 'local',
  MAX_BROWSER_INSTANCES: '3',
  API_KEY_DEFAULT_TTL_DAYS: '0',
  // Keep automatic reconnection out of the way unless a test opts in.
  AUTO_RECONNECT_ON_STARTUP: 'false',
};

/**
 * Start the app on an ephemeral port.
 * @param {Record<string, unknown>} [options]
 * @param {Record<string,string>} [options.env] extra/overriding environment
 * @param {Function} [options.libraryFactory] replaces whatsapp-web.js
 * @param {Function} [options.cloudClientFactory] replaces the Cloud API client
 * @param {string} [options.dataDir] reuse a data directory (e.g. restart tests)
 */
export async function startTestApp(options = {}) {
  const dataDir = options.dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'rb-wa-data-')));
  const env = {
    ...BASE_TEST_ENV,
    DATA_DIR: dataDir,
    ...(options.env ?? {}),
  };

  const config = loadConfig(env);
  const logger = options.logger ?? createLogger(config);
  const container = createContainer({
    config,
    logger,
    libraryFactory: options.libraryFactory ?? null,
    cloudClientFactory: options.cloudClientFactory ?? null,
  });
  await container.start();
  const app = createApp({ config, container });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let closed = false;

  /** Issue an API key directly through the service (bypasses the admin route). */
  async function issueKey({ tenantId = 'tenant-a', scopes = ['*'], allowedInstanceIds = null, name = 'test-key' } = {}) {
    const { plaintext, record } = await container.apiKeys.generate({
      tenantId,
      name,
      scopes,
      allowedInstanceIds,
    });
    return { plaintext, record };
  }

  /** Perform an HTTP request and decode the JSON body when present. */
  async function request(urlPath, { method = 'GET', apiKey, body, headers = {}, json = true } = {}) {
    const requestHeaders = { ...headers };
    if (apiKey) requestHeaders['x-api-key'] = apiKey;
    let payload;
    if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${urlPath}`, { method, headers: requestHeaders, body: payload });
    const text = await response.text();
    let parsed = null;
    if (json && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  /** Create an instance through the API and return its representation. */
  async function createInstance(apiKey, payload = { connector: 'cloud_api', displayName: 'test instance' }) {
    const response = await request('/api/v1/instances', { method: 'POST', apiKey, body: payload });
    if (response.status !== 201) {
      throw new Error(`Failed to create instance: ${response.status} ${response.text}`);
    }
    return response.body.data.instance;
  }

  return {
    config,
    container,
    logger,
    server,
    baseUrl,
    dataDir,
    request,
    issueKey,
    createInstance,

    /** Wait for a condition to become true (polling helper for async flows). */
    async waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },

    async close({ removeDataDir = true } = {}) {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
      await container.shutdown();
      if (removeDataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Convenience: an instance of the app whose lifecycle is tied to the test. */
export function withApp(t, options) {
  return startTestApp(options).then((app) => {
    t.after(() => app.close());
    return app;
  });
}
