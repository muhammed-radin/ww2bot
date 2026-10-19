#!/usr/bin/env node
/**
 * Maintenance job: enforce retention limits.
 *
 *   npm run session:purge
 *
 * Deletes retained messages and delivery metadata past each instance's retention
 * window, prunes webhook de-duplication markers and old audit events, and
 * removes leftover temporary files. Intended to run from a cron/Kubernetes
 * CronJob.
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import { createContainer } from '../src/container.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const container = createContainer({ config, logger });

  try {
    await container.start();
    const result = await container.retention.purgeExpiredForAllInstances();
    logger.info({ result }, 'retention maintenance completed');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await container.shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.name === 'ConfigError' ? error.message : error?.stack ?? error}\n`);
  process.exit(1);
});
