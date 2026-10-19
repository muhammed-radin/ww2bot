#!/usr/bin/env node
/**
 * Revoke an API key. Revocation is immediate.
 *
 *   npm run key:revoke -- --key-id <keyId> [--tenant <tenantId>]
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import { createContainer } from '../src/container.js';
import { parseArgs } from './create-api-key.js';
import { isMainModule } from '../src/utils/isMain.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['key-id']) {
    process.stderr.write('Usage: npm run key:revoke -- --key-id <keyId> [--tenant <tenantId>]\n');
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger({ ...config, logLevel: 'warn' });
  const container = createContainer({ config, logger });

  try {
    await container.start();
    const result = await container.apiKeys.revoke(String(args['key-id']), {
      tenantId: args.tenant ? String(args.tenant) : undefined,
    });
    process.stdout.write(
      result.alreadyRevoked
        ? `Key ${result.keyId} was already revoked.\n`
        : `Key ${result.keyId} revoked at ${new Date(result.revokedAt).toISOString()}.\n`,
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
