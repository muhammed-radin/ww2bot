/**
 * Process entry point: build the container, start HTTP, shut down gracefully.
 *
 * Shutdown order matters: stop accepting connections, let in-flight requests
 * finish, close event streams, tear down browsers, then stop the background
 * supervisors. A hard timeout guarantees the process always exits.
 */
import http from 'node:http';
import { loadConfig } from './config/env.js';
import { createLogger } from './utils/logger.js';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { isMainModule } from './utils/isMain.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  for (const warning of config.warnings) logger.warn({ warning }, 'configuration warning');
  if (config.security.ephemeralApiKeyPepper || config.encryption.ephemeral) {
    logger.warn(
      'Ephemeral development secrets are in use. Existing API keys and stored ciphertext will not survive a restart. ' +
        'Set API_KEY_PEPPER and an encryption key ring before running in production.',
    );
  }

  const container = createContainer({ config, logger });
  // Fail fast (with a clear message) when persistent storage is unusable.
  const { recovered } = await container.start();
  const app = createApp({ config, container });
  const server = http.createServer(app);

  // Slowloris-style protection: bound how long a connection may take.
  server.headersTimeout = 20000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 65000;

  await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve));
  logger.info(
    {
      port: config.server.port,
      host: config.server.host,
      repositoryMode: container.repositories.mode,
      dataDir: config.data.dir,
      webConnector: config.connectors.web.enabled ? 'enabled' : 'disabled',
      defaultConnector: config.connectors.default,
      recovered,
    },
    'razorbills-whatsapp started',
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    const forceExit = setTimeout(() => {
      logger.error({ signal }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdown.timeoutMs);
    forceExit.unref();

    try {
      await new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();

      // Give in-flight responses a moment, then drop the rest (SSE streams).
      setTimeout(() => server.closeAllConnections?.(), 2000).unref?.();

      await container.shutdown();
      logger.info({ signal }, 'shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error, signal }, 'error during shutdown');
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });

  return { server, container, config };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((error) => {
    // Configuration errors are printed in full: they contain no secrets.
    if (error?.name === 'ConfigError') {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`Failed to start razorbills-whatsapp: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}

export { main };
