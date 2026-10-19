const e=`# Deployment

## Docker

The default image is lean: only the official Cloud API connector ships.

Build the dashboard **before** building the image — the image copies the
published bundle in (\`COPY public ./public\`) and does not run a frontend build:

\`\`\`bash
npm --prefix ww2web install
npm run build:frontend      # publishes ww2web into public/frontend

# Official Cloud API connector only (default)
docker build -t razorbills-whatsapp .

# With the optional, authorization-gated WhatsApp Web connector
docker build --build-arg INSTALL_WEB_CONNECTOR=true -t razorbills-whatsapp:web .
\`\`\`

If \`public/frontend/\` is empty the image still builds and runs; \`/ui/\` then
answers \`503\` until the dashboard is published and the image is rebuilt.

The image is multi-stage: dependencies are installed in a builder stage, and only
\`node_modules\` and the application code are copied into the runtime stage. The
container:

- runs as the **non-root** \`node\` user,
- uses \`tini\` as PID 1 for correct signal handling and graceful shutdown,
- stores all state in the \`DATA_DIR\` volume (\`/app/data\`, declared as a \`VOLUME\`),
- serves the dashboard at \`/ui/\` from the bundled \`public/frontend/\`,
- exposes **only port 3000** — there is **no remote-debugging port**,
- **does not disable Chromium's sandbox by default** (the explicit
  \`WHATSAPP_WEB_NO_SANDBOX=true\` development fallback exists for hosts that
  cannot provide user namespaces), and
- defines a \`HEALTHCHECK\` against \`/health/live\`.

The web variant additionally installs Chromium's shared libraries. Running
headless Chromium **with** its sandbox inside a container typically requires user
namespaces or, where the host disables them, an explicit capability. The image
does **not** weaken the sandbox; grant the required privilege at the container
level if the host needs it.

### Run the image

\`\`\`bash
docker run -d --name razorbills-whatsapp \\
  -p 127.0.0.1:3000:3000 \\
  -v gateway-data:/app/data \\
  --env-file .env \\
  razorbills-whatsapp
\`\`\`

## Docker Compose

\`compose.yaml\` brings up a **single** \`gateway\` service with one persistent
\`gateway-data\` volume at \`/app/data\`, binds the API to loopback by default,
drops all Linux capabilities, and sets \`no-new-privileges\`. There is no database
and no migration step.

\`\`\`bash
cp .env.example .env          # set API_KEY_PEPPER, ENCRYPTION_KEYS, META_* values
docker compose up -d --build
docker compose logs -f gateway
\`\`\`

- Set \`GATEWAY_BIND\` / \`GATEWAY_PORT\` to change the published address.
- Set \`INSTALL_WEB_CONNECTOR=true\` to build the web-connector image.

## Bare metal / systemd (sketch)

\`\`\`ini
[Unit]
Description=razorbills-whatsapp
After=network.target

[Service]
Type=simple
User=razorbills
WorkingDirectory=/opt/razorbills-whatsapp
EnvironmentFile=/etc/razorbills-whatsapp.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/razorbills-whatsapp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
\`\`\`

- Run as a dedicated non-root user.
- Point \`DATA_DIR\` at a persistent, \`0700\` directory.
- Provide secrets via the environment file or a secret manager, not a committed
  file.

## Reverse proxy

Terminate TLS in front of the service and forward to the loopback-bound API:

- Set \`TRUST_PROXY=true\` (or an appropriate value) so \`req.ip\` reflects the real
  client for rate limiting and \`IP_ALLOWLIST\`.
- Set \`CORS_ORIGINS\` to the specific origins that need browser access.
- Consider \`IP_ALLOWLIST\` to restrict the API to the backend's egress.
- SSE needs buffering disabled: the service already sends
  \`X-Accel-Buffering: no\`, but ensure the proxy does not buffer
  \`text/event-stream\` responses.

## Production checklist

- [ ] \`NODE_ENV=production\`; \`DATA_DIR\` on a persistent, \`0700\` volume on
      encrypted storage.
- [ ] \`API_KEY_PEPPER\` (≥ 32 chars) and the AES-256-GCM keyring are injected from
      a secret manager — never a committed file. **Back the keyring up
      separately.**
- [ ] \`CORS_ORIGINS\` is a specific allowlist (not \`*\`); \`IP_ALLOWLIST\` restricts
      the API to the backend's egress where possible.
- [ ] A **single** service process runs against each \`DATA_DIR\` (no multiple
      replicas).
- [ ] The API sits behind a TLS-terminating proxy; bind to loopback where
      possible. No debugging ports exposed.
- [ ] Cloud API credentials (\`META_ACCESS_TOKEN\`, \`META_PHONE_NUMBER_ID\`,
      \`META_VERIFY_TOKEN\`, \`META_APP_SECRET\`) are set and the webhook is
      subscribed to \`messages\`.
- [ ] The owner key holds \`auth:manage\`/\`keys:manage\`; the RazorBills key holds
      \`messages:send\` only. Keys live in a secret manager and are rotated on a
      schedule.
- [ ] Retention is a deliberate choice per instance; audit and delivery-metadata
      retention are set.
- [ ] The web connector, if enabled at all, has a recorded
      \`WHATSAPP_WEB_AUTHORIZATION_REFERENCE\`, a private session directory, and
      \`WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted\` for encryption at rest.
- [ ] Retention maintenance is scheduled (\`npm run session:purge\`).
- [ ] Backup of \`DATA_DIR\` + keyring is automated and restore has been tested.
- [ ] The dashboard is published (\`npm run build:frontend\`) and \`/ui/\` is only
      reachable over HTTPS, so the owner-session cookie is sent \`Secure\` and
      \`OWNER_SESSION_COOKIE_SECURE\` can stay at its production default.
- [ ] Reverse-proxy rules do not buffer \`/api/v1/instances/:id/auth/events\`
      (SSE) and do not cache \`/ui/\` or \`/frontend/*\`.

## Verification status

> **Note:** Docker was not available in the environment this project was
> developed in, so the image and compose stack have **not** been built or run
> here. The files are written to be correct and complete but should be validated
> in your CI before first production use. Likewise, the web connector's real
> browser flow (which needs \`whatsapp-web.js\` + \`puppeteer\`) is covered by an
> injected fake library rather than a real Chromium run.

## Related

- [Operations](./operations.md)
- [Configuration](./configuration.md)
- [Security](./security.md)
`;export{e as default};
