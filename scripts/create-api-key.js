#!/usr/bin/env node
/**
 * Bootstrap / administrative API key creation.
 *
 * This is the documented way to create the FIRST (owner) key. It writes to the
 * configured data directory and uses the configured pepper directly, so whoever
 * can run it already has the privileges that matter. There is no default key in
 * the repository, and the secret is printed exactly once.
 *
 * Two kinds of key are normal:
 *   - the owner key, holding every scope (including `auth:manage` and
 *     `keys:manage`) and used only by the owner from a trusted host;
 *   - the RazorBills service key, holding `messages:send` (optionally
 *     `instances:read`/`connection:read`) and nothing else.
 *
 * Usage:
 *   npm run key:create -- --preset owner --name "owner"
 *   npm run key:create -- --preset service --name "razorbills"
 *
 * Options:
 *   --preset            owner (all scopes) | service (messages:send)
 *   --tenant            tenant id (default: default)
 *   --name              human-readable label
 *   --scopes            comma separated; default: all scopes (owner)
 *   --allowed-instances comma separated instance ids to restrict the key to
 *   --ttl-days          expiry in days (default: API_KEY_DEFAULT_TTL_DAYS)
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import { createContainer } from '../src/container.js';
import { ALL_SCOPES, SCOPES } from '../src/config/security.js';
import { isMainModule } from '../src/utils/isMain.js';

/** Named scope presets. `owner` mirrors the CLI default; `service` is least privilege. */
export const KEY_PRESETS = Object.freeze({
  owner: [...ALL_SCOPES],
  service: [SCOPES.MESSAGES_SEND],
});

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [flag, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      args[flag] = inlineValue;
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args[flag] = next;
        index += 1;
      } else {
        args[flag] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger({ ...config, logLevel: 'warn' });
  const container = createContainer({ config, logger });

  try {
    await container.start();

    const presetScopes = args.preset ? KEY_PRESETS[String(args.preset)] : undefined;
    if (args.preset && !presetScopes) {
      throw new Error(`Unknown --preset "${args.preset}". Valid presets: ${Object.keys(KEY_PRESETS).join(', ')}`);
    }

    const scopes = args.scopes
      ? String(args.scopes)
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean)
      : (presetScopes ?? [...ALL_SCOPES]);

    const allowedInstanceIds = args['allowed-instances']
      ? String(args['allowed-instances'])
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : null;

    const { plaintext, record } = await container.apiKeys.generate({
      tenantId: args.tenant ?? 'default',
      name: args.name ?? 'bootstrap-key',
      scopes,
      allowedInstanceIds,
      ttlDays: args['ttl-days'] ? Number(args['ttl-days']) : undefined,
    });

    process.stdout.write(
      [
        '',
        'API key created. This secret is shown ONCE and is not stored anywhere.',
        '',
        `  key id : ${record.keyId}`,
        `  tenant : ${record.tenantId}`,
        `  scopes : ${record.scopes.join(', ')}`,
        `  expires: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'never'}`,
        '',
        `  X-API-Key: ${plaintext}`,
        '',
        `Store it in your secret manager now. Revoke with: npm run key:revoke -- --key-id ${record.keyId}`,
        `Reading audit events needs the ${SCOPES.AUDIT_READ} scope; managing WhatsApp connections needs ${SCOPES.AUTH_MANAGE}.`,
        `The RazorBills integration key only needs: --scopes ${SCOPES.MESSAGES_SEND}`,
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
