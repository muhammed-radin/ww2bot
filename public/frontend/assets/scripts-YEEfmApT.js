const e=`# Scripts

Command-line utilities. All of them load the same configuration as the server
(\`loadConfig\`), build a container, and shut it down cleanly. They are designed to
run on the same host (and with the same \`DATA_DIR\` and secrets) as the service.

> **Single-process note.** The CLI opens the same \`DATA_DIR\` as the server. Stop
> the server before running a maintenance script against the same directory, or
> run it from a controlled maintenance window, to avoid two processes writing the
> same files.

## \`npm run key:create\`

Bootstrap / administrative API key creation. This is the documented way to create
the **first (owner) key**. There is no default key in the repository, and the
secret is printed **exactly once**.

\`\`\`bash
npm run key:create -- [options]
\`\`\`

| Option | Description |
| --- | --- |
| \`--preset <owner\\|service>\` | \`owner\` = all scopes; \`service\` = \`messages:send\`. |
| \`--tenant <id>\` | Tenant id (default \`default\`). |
| \`--name <label>\` | Human-readable label. |
| \`--scopes <a,b,c>\` | Comma-separated scopes (default: all scopes). |
| \`--allowed-instances <id,id>\` | Restrict the key to specific instance ids. |
| \`--ttl-days <n>\` | Expiry in days (default: \`API_KEY_DEFAULT_TTL_DAYS\`). |

Examples:

\`\`\`bash
npm run key:create -- --preset owner --name owner
npm run key:create -- --preset service --name razorbills
npm run key:create -- --name razorbills --scopes messages:send,instances:read
npm run key:create -- --preset service --allowed-instances ins_ab12...,ins_cd34...
\`\`\`

Output includes the key id, tenant, scopes, expiry and the \`X-API-Key\` value.
Store it in your secret manager immediately.

## \`npm run key:revoke\`

Revoke a key. Revocation is immediate.

\`\`\`bash
npm run key:revoke -- --key-id <keyId> [--tenant <tenantId>]
\`\`\`

## \`npm run key:rotate\`

Rotate a key: issue a new secret and revoke the previous one.

\`\`\`bash
npm run key:rotate -- --key-id <keyId> [--grace-period-ms <ms>]
\`\`\`

A non-zero \`--grace-period-ms\` keeps the previous key valid for that long, which
is useful for zero-downtime credential rollouts. Default is immediate revocation.

## \`npm run session:purge\`

Enforce retention limits. Intended to run from cron or a Kubernetes CronJob.

\`\`\`bash
npm run session:purge
\`\`\`

Deletes retained messages and delivery metadata past each instance's retention
window, prunes webhook de-duplication markers and old audit events, and removes
leftover temporary files.

Prints a JSON summary:

\`\`\`json
{
  "instances": 3,
  "messagesDeleted": 42,
  "webhookEventsDeleted": 120,
  "auditEventsDeleted": 5,
  "deliveriesDeleted": 17
}
\`\`\`

See [Data retention and privacy](./data-retention.md).

## \`npm run sync:docs\`

Copies the repository's \`docs/*.md\` into \`ww2web/src/content/docs/\` and
regenerates the manifest (\`index.json\`) used by the dashboard's Documentation
page.

\`\`\`bash
npm run sync:docs
\`\`\`

It runs automatically as the first step of \`npm run build:frontend\`, so a
published dashboard always matches the repository. Run it by hand only while
using the Vite dev server after editing a document. The copy is generated: never
edit \`ww2web/src/content/docs/\` directly.

## \`npm run build:frontend\`

Builds the \`ww2web\` dashboard and publishes it where the service serves it from.

\`\`\`bash
npm --prefix ww2web install   # first time only
npm run build:frontend
\`\`\`

1. runs \`scripts/sync-docs.js\` to refresh the bundled documentation;
2. runs \`vite build\` inside \`ww2web/\` (Vite emission goes to \`ww2web/dist/\`);
3. verifies \`dist/index.html\` exists and references the \`/frontend/\` asset base;
4. stages a full copy, then replaces \`public/frontend/\` with it.

The publish step is a same-filesystem directory rename, so a build failure or an
interrupted run never leaves a partially-served dashboard. Unrelated files under
\`public/\` are untouched. This is the only supported way to publish the UI; see
[Owner dashboard](./admin-dashboard.md#build-and-publish).

## Setup

\`\`\`bash
npm run setup:web-connector
# = npm install --include=optional whatsapp-web.js puppeteer
\`\`\`

Installs the optional browser stack required by the authorised WhatsApp Web
connector.

## Related

- [Authentication → Bootstrapping keys](./authentication.md#bootstrapping-keys-cli)
- [Operations → Routine maintenance](./operations.md#routine-maintenance)
- [Getting started](./getting-started.md)
`;export{e as default};
