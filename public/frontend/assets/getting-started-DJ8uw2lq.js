const e=`# Getting started

This guide takes you from a clean checkout to a running service with an owner key
and a narrow RazorBills integration key.

## 1. Requirements

- **Node.js ≥ 20.11** (developed and tested on Node 22/24).
- A **persistent, access-restricted volume** mounted at \`DATA_DIR\`.
- For the web connector only: the optional \`whatsapp-web.js\` + \`puppeteer\`
  dependencies and a host able to run Chromium.

There is no database, no Redis and no migration step.

## 2. Install

\`\`\`bash
# Official Cloud API connector only (default; skips the optional browser stack)
npm install --omit=optional

# If you also need the authorised WhatsApp Web connector:
npm run setup:web-connector
\`\`\`

\`npm install\` (without \`--omit=optional\`) will pull the optional
\`whatsapp-web.js\` and \`puppeteer\` packages, including a bundled Chromium.

## 3. Configure

\`\`\`bash
cp .env.example .env
\`\`\`

Generate the two mandatory secrets and put them in \`.env\`:

\`\`\`bash
# 48 random bytes, base64-encoded (minimum 32 characters)
node -e "console.log('API_KEY_PEPPER=' + require('crypto').randomBytes(48).toString('base64'))"

# A single 32-byte AES-256 key in a JSON keyring
node -e "console.log('ENCRYPTION_KEYS={\\"k1\\":\\"' + require('crypto').randomBytes(32).toString('base64') + '\\"}')"
\`\`\`

Set at least:

\`\`\`dotenv
NODE_ENV=development
DATA_DIR=./data
API_KEY_PEPPER=<generated>
ENCRYPTION_KEY_ID=k1
ENCRYPTION_KEYS={"k1":"<generated>"}
\`\`\`

If you are using the official connector, also set the Cloud API values:

\`\`\`dotenv
DEFAULT_CONNECTOR=cloud_api
META_ACCESS_TOKEN=<token>
META_PHONE_NUMBER_ID=<id>
META_VERIFY_TOKEN=<random-string-you-choose>
META_APP_SECRET=<app-secret>
\`\`\`

See [Configuration](./configuration.md) for the full reference.

> **Development convenience.** If \`API_KEY_PEPPER\` or the encryption keyring are
> unset in a non-production environment, the service generates an **ephemeral**
> value and warns loudly. Existing API keys and stored ciphertext will not
> survive a restart. Never rely on this outside local development.

## 4. Start the service

\`\`\`bash
npm start          # or: npm run dev  (node --watch)
\`\`\`

On first run the data directory tree is created (\`0700\` directories, \`0600\`
files). If \`DATA_DIR\` cannot be created or written, startup fails fast with a
single \`SERVICE_UNAVAILABLE\` error naming \`DATA_DIR\` — the service never starts
in a half-working state that would silently discard sessions.

Verify it is up:

\`\`\`bash
curl -s http://localhost:3000/health/live
# { "success": true, "data": { "status": "ok", "service": "razorbills-whatsapp", "uptimeSeconds": 3 } }

curl -s http://localhost:3000/health/ready
# { "success": true, "data": { "status": "ready", "checks": { "storage": { "ok": true, "mode": "filesystem" }, ... } } }
\`\`\`

## 5. Create the first owner key

\`auth:manage\` and \`keys:manage\` are owner-only. There is **no default key** in
the repository and **no unrestricted key-creation endpoint**; the first owner
key is created with the CLI, which writes to the configured data directory using
the configured pepper. Whoever can run it already holds the privileges that
matter.

\`\`\`bash
# Owner key: every scope (auth:manage, keys:manage, ...). Printed once.
npm run key:create -- --preset owner --name owner
\`\`\`

Store the printed \`X-API-Key\` in a secret manager immediately. It cannot be
retrieved again.

## 6. Create the RazorBills integration key

The backend only needs the narrow outbound scope:

\`\`\`bash
npm run key:create -- --preset service --name razorbills
# equivalent to: --scopes messages:send
\`\`\`

Optionally add \`instances:read\` (or \`connection:read\`) if the backend must read
instance metadata or connection status:

\`\`\`bash
npm run key:create -- --name razorbills \\
  --scopes messages:send,instances:read,connection:read
\`\`\`

Restrict a key to specific instances with \`--allowed-instances\`:

\`\`\`bash
npm run key:create -- --preset service --allowed-instances ins_ab12...cd34
\`\`\`

## 7. Create an instance and verify the connection

\`\`\`bash
# Create an instance (owner key)
curl -s -X POST http://localhost:3000/api/v1/instances \\
  -H "X-API-Key: $OWNER_KEY" -H 'Content-Type: application/json' \\
  -d '{"connector":"cloud_api","displayName":"Acme support","retentionEnabled":true,"retentionDays":7}'

# For cloud_api, "connect" verifies credentials with a documented Graph API
# call. There is no QR code.
curl -s -X POST http://localhost:3000/api/v1/instances/$INSTANCE_ID/connect/qr \\
  -H "X-API-Key: $OWNER_KEY"

# Send a message with the narrow key
curl -s -X POST http://localhost:3000/api/v1/messages/send \\
  -H "X-API-Key: $RAZORBILLS_KEY" -H 'Content-Type: application/json' \\
  -d '{"instanceId":"'"$INSTANCE_ID"'","to":"15551234567","text":"Your invoice is ready","idempotencyKey":"order-42"}'
\`\`\`

## 8. Next steps

- Open the owner dashboard (optional): build it once, then browse to \`/ui/\`.

  \`\`\`bash
  npm --prefix ww2web install    # frontend dependencies (separate package.json)
  npm run build:frontend         # publishes the UI into public/frontend
  # open http://localhost:3000/ui/ and sign in with $OWNER_KEY
  \`\`\`

  The dashboard is served by this same process — no extra port, no database. It
  adds endpoints only for its own views; nothing about the API changes. See
  [Owner dashboard](./admin-dashboard.md).

- Learn which scope each endpoint needs: [API reference](./api-reference.md) and
  [Authentication](./authentication.md).
- Understand the connector you are using: [Connectors](./connectors.md).
- Read the [production checklist](./deployment.md#production-checklist) before
  going live.
- Learn the data layout and backup procedure: [Storage](./storage.md) and
  [Operations](./operations.md).

## Troubleshooting the first run

| Symptom | Likely cause |
| --- | --- |
| Startup exits with \`Invalid configuration: ...\` | A required env var is missing or malformed. The message lists each problem. |
| Startup exits with \`DATA_DIR ... is not usable\` | \`DATA_DIR\` does not exist / is not writable by the process user. |
| Every request returns \`401 UNAUTHORIZED\` | Missing/incorrect \`X-API-Key\` header. Keys are **header-only**, never query/path. |
| Every request returns \`403 FORBIDDEN\` | The key lacks the required scope. |
| Requests rejected with \`IP_NOT_ALLOWED\` | \`IP_ALLOWLIST\` is set and your IP is not in it. |
| Logs warn about an ephemeral pepper or keyring | You did not set \`API_KEY_PEPPER\` / \`ENCRYPTION_KEYS\`. Set real secrets. |

More in [Operations → Troubleshooting](./operations.md#troubleshooting).
`;export{e as default};
