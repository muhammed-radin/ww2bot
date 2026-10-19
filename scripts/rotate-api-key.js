#!/usr/bin/env node
/**
 * Rotate an API key: issues a new secret and revokes the previous one.
 *
 *   npm run key:rotate -- --key-id <keyId> [--grace-period-ms 300000]
 *
 * A non-zero grace period keeps the previous key valid for that long, which is
 * useful for zero-downtime credential rollouts. Default is immediate revocation.
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import { createContainer } from '../src/container.js';
import { parseArgs } from './create-api-key.js';
import { isMainModule } from '../src/utils/isMain.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['key-id']) {
    process.stderr.write('Usage: npm run key:rotate -- --key-id <keyId> [--grace-period-ms <ms>]\n');
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger({ ...config, logLevel: 'warn' });
  const container = createContainer({ config, logger });

  try {
    await container.start();
    const { plaintext, record } = await container.apiKeys.rotate(String(args['key-id']), {
      gracePeriodMs: args['grace-period-ms'] ? Number(args['grace-period-ms']) : 0,
    });
    process.stdout.write(
      [
        '',
        `Rotated key ${args['key-id']} -> ${record.keyId}`,
        record.expiresAt ? `  expires: ${new Date(record.expiresAt).toISOString()}` : '  expires: never',
        '',
        `  X-API-Key: ${plaintext}`,
        '',
        'Store the new secret in your secret manager now; it is shown once.',
        '',
      ].join('\n'),
    );
  } finally {
    await container.shutdown();
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.name === 'ConfigError' ? error.message : error?.stack ?? error}\n`);
    process.exit(1);
  });
}
