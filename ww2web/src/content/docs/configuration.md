# Configuration

All configuration is environment-driven and validated at startup by
`src/config/env.js`. The canonical template is
[`../.env.example`](../.env.example).

- Boolean values accept `true/1/yes/on` and `false/0/no/off` (case-insensitive).
- Empty strings are treated as "unset" (the fallback applies).
- The resulting config object is deeply frozen — configuration is read-only at
  runtime.
- Invalid configuration aborts startup with a single `Invalid configuration:`
  message listing every problem. It contains no secrets.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | One of `development`, `production`, `test`. Controls fail-fast rules and logging. |
| `PORT` | `3000` | HTTP port (1–65535). |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a reverse proxy. |
| `SERVICE_NAME` | `razorbills-whatsapp` | Name used in logs and `/health/live`. |
| `LOG_LEVEL` | `info` | `fatal\|error\|warn\|info\|debug\|trace\|silent`. |

## Storage

| Variable | Default | Description |
| --- | --- | --- |
| `DATA_DIR` | `./data` | **The only stateful dependency.** All keys, instances, connection state, sessions, deliveries and audit events live here. |
| `DEFAULT_TENANT_ID` | `default` | The single internal owner tenant id. Do not change after instances exist. |

> In production, `DATA_DIR=./data` is allowed but emits a warning: it must point
> at a persistent, access-restricted volume. If `DATA_DIR` cannot be created or
> written, startup fails fast with `SERVICE_UNAVAILABLE` / `DATA_DIR_UNAVAILABLE`.

## API keys

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEY_PEPPER` | _(none)_ | Server-side pepper mixed into the HMAC used to store keys. **≥ 32 characters**, not a well-known placeholder. Required in production. |
| `API_KEY_DEFAULT_TTL_DAYS` | `0` | Default lifetime (days) for newly created keys. `0` = never expires. |

Well-known placeholder values that are rejected: `changeme`, `change-me`,
`secret`, `test`, `please-change-me`, `your-secret-here`, `api-key-pepper`.

Invalidating the pepper invalidates every existing key.

## Encryption at rest (AES-256-GCM)

| Variable | Default | Description |
| --- | --- | --- |
| `ENCRYPTION_KEY_PROVIDER` | `env` | `env` (inline keyring) or `file` (read the keyring from a file). |
| `ENCRYPTION_KEY_ID` | `k1` | The **active** key id. Must be present in the keyring. |
| `ENCRYPTION_KEYS` | _(none)_ | Inline JSON keyring `{"k1":"<base64 32 bytes>", ...}`. Dev / simple deployments. |
| `ENCRYPTION_KEYS_FILE` | _(none)_ | Path to a JSON keyring file. Required when `ENCRYPTION_KEY_PROVIDER=file`. |

Rules:

- Every key must decode to **exactly 32 bytes**.
- Key ids match `^[A-Za-z0-9_-]{1,64}$`.
- Old keys stay in the ring so existing ciphertext still decrypts; change
  `ENCRYPTION_KEY_ID` to rotate new writes.
- Production **requires** a non-empty keyring; a missing active key id is a fatal
  error.

## Connectors

| Variable | Default | Description |
| --- | --- | --- |
| `DEFAULT_CONNECTOR` | `cloud_api` | Connector for new instances: `cloud_api` or `web`. |

### Official WhatsApp Business Platform (Cloud API)

| Variable | Default | Description |
| --- | --- | --- |
| `META_ACCESS_TOKEN` | _(none)_ | Graph API access token. |
| `META_PHONE_NUMBER_ID` | _(none)_ | Business phone-number id. |
| `META_VERIFY_TOKEN` | _(none)_ | Webhook verification token (you choose it; also entered in Meta). |
| `META_APP_SECRET` | _(none)_ | App secret used to verify `X-Hub-Signature-256`. |
| `META_API_VERSION` | `v21.0` | Graph API version. |
| `META_GRAPH_BASE_URL` | `https://graph.facebook.com` | Graph API base URL. |

Cross-field rules:

- `META_ACCESS_TOKEN` and `META_PHONE_NUMBER_ID` must be set **together**.
- `META_VERIFY_TOKEN` requires `META_APP_SECRET` (signature verification).

The connector is `configured` only when both token and phone-number id are set;
`webhooksEnabled` only when both verify token and app secret are set.

### Authorised WhatsApp Web connector

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_WHATSAPP_WEB_CONNECTOR` | `false` | Master switch. Disabled by default. |
| `WHATSAPP_WEB_AUTHORIZATION_REFERENCE` | _(none)_ | **Required** when the connector is enabled: a reference to the written authorisation you hold (contract/ticket/DPA id). Recorded in the audit log; never a secret. |
| `WHATSAPP_WEB_AUTH_STRATEGY` | `local` | `local` (LocalAuth disk profile, **not** encrypted by this service) or `remote_encrypted` (RemoteAuth archive encrypted with AES-256-GCM). |
| `WHATSAPP_WEB_HEADLESS` | `true` | Run Chromium headless. |
| `WHATSAPP_WEB_NO_SANDBOX` | `false` | Disable Chromium's sandbox (`--no-sandbox`). Only for hosts that block unprivileged user namespaces and cannot use the SUID sandbox; weakens browser isolation. |
| `WHATSAPP_WEB_PAIRING_INTERVAL_MS` | `180000` | How often WhatsApp re-issues a pairing code (min 30000). |
| `WHATSAPP_WEB_LAUNCH_TIMEOUT_MS` | `60000` | Per-instance browser launch timeout (min 10000). |

Rules and warnings:

- `ENABLE_WHATSAPP_WEB_CONNECTOR=true` **without**
  `WHATSAPP_WEB_AUTHORIZATION_REFERENCE` is a **fatal** error (deliberate).
- `DEFAULT_CONNECTOR=web` requires `ENABLE_WHATSAPP_WEB_CONNECTOR=true`.
- In production, `WHATSAPP_WEB_AUTH_STRATEGY=local` emits a warning, because the
  browser profile is stored unencrypted on disk.

## Connection recovery

| Variable | Default | Description |
| --- | --- | --- |
| `AUTO_RECONNECT_ON_STARTUP` | `true` | Reconnect previously-live **cloud_api** instances after a restart. The web connector always requires the owner. |
| `RECONNECT_ENABLED` | `true` | Enable the reconnection supervisor at all. |
| `RECONNECT_BASE_DELAY_MS` | `2000` | First backoff delay (min 100). |
| `RECONNECT_MAX_DELAY_MS` | `300000` | Cap on backoff delay (min 1000). |
| `RECONNECT_MAX_ATTEMPTS` | `10` | Give up (enter `ERROR`) after this many attempts. |
| `RECONNECT_MAX_DURATION_MS` | `900000` | Give up after this total duration. |
| `RECONNECT_JITTER` | `0.2` | Random jitter factor applied to each delay (0–1). |
| `RECONNECT_STABLE_RESET_MS` | `60000` | How long a connection must stay healthy before the attempt counter resets. |

`RECONNECT_BASE_DELAY_MS` must not exceed `RECONNECT_MAX_DELAY_MS`.

## Outbound messaging

| Variable | Default | Description |
| --- | --- | --- |
| `OUTBOUND_MESSAGING_ENABLED` | `true` | Allow `POST /messages/send`. |
| `IDEMPOTENCY_TTL_MS` | `86400000` | How long a stored idempotency key suppresses a duplicate send (1–30 days). |
| `DELIVERY_METADATA_RETENTION_DAYS` | `7` | Retention for outbound delivery metadata (`0` = do not retain). |

`DELIVERY_METADATA_RETENTION_DAYS=0` while outbound is enabled emits a warning:
idempotency of outbound sends is lost.

## HTTP security

| Variable | Default | Description |
| --- | --- | --- |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated origin allowlist. Empty allows only requests without an `Origin` header (server-to-server). `*` is rejected in production. |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting: `true`, `false`, a hop count, or a value like `loopback`. |
| `BODY_LIMIT` | `100kb` | JSON body size limit. |
| `IP_ALLOWLIST` | _(empty)_ | Optional source-IP allowlist. Exact IPv4/IPv6 addresses or IPv4 CIDR ranges. Empty disables the check. |

In production, `CORS_ORIGINS` must be non-empty and must not contain `*`.

## Owner dashboard sessions

The administration dashboard ([`ww2web`](./admin-dashboard.md)) signs in by
exchanging an owner API key for a server-side session held in an `HttpOnly`
cookie. Nothing is written to disk.

| Variable | Default | Description |
| --- | --- | --- |
| `OWNER_SESSION_TTL_MS` | `43200000` (12 h) | Absolute session lifetime. |
| `OWNER_SESSION_IDLE_MS` | `3600000` (1 h) | Sliding idle timeout; capped at the TTL. |
| `OWNER_SESSION_MAX` | `20` | Maximum concurrent owner sessions (1–200); the oldest is evicted. |
| `OWNER_SESSION_COOKIE_SECURE` | `NODE_ENV === 'production'` | Set the cookie's `Secure` attribute. Set `false` only when testing the dashboard over plain HTTP. |

The cookie is always `HttpOnly`, `SameSite=Strict` and scoped to `/`. Sessions
are in-memory only and disappear on restart; a session is also revoked when the
API key that created it is revoked.

## Rate limiting

In-memory, applied **per API key and per IP** (both are composed into the bucket
key). Counters reset on restart.

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Default window for read/write/admin/IP limits. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Default max requests per window. |
| `RATE_LIMIT_CONNECT_WINDOW_MS` | `60000` | Window for connect/disconnect/session/QR endpoints. |
| `RATE_LIMIT_CONNECT_MAX_REQUESTS` | `5` | Max connect-family requests per window. |
| `RATE_LIMIT_AUTH_WINDOW_MS` | `60000` | Window for auth/stream-token endpoints. |
| `RATE_LIMIT_AUTH_MAX_REQUESTS` | `10` | Max auth requests per window. |
| `RATE_LIMIT_SEND_WINDOW_MS` | `60000` | Window for outbound sends. |
| `RATE_LIMIT_SEND_MAX_REQUESTS` | `120` | Max sends per key/IP per window. |
| `RATE_LIMIT_RECIPIENT_WINDOW_MS` | `60000` | Window for the per-recipient send limit. |
| `RATE_LIMIT_RECIPIENT_MAX_REQUESTS` | `20` | Max sends to one recipient per window. |

## Browser / instance limits

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_BROWSER_INSTANCES` | `3` | Maximum concurrent Chromium instances (1–50). Admission control. |
| `QR_TTL_MS` | `45000` | How long a QR challenge remains valid. |

## Real-time event streams

| Variable | Default | Description |
| --- | --- | --- |
| `STREAM_TOKEN_TTL_MS` | `60000` | Lifetime of a single-use SSE stream token. |
| `SSE_HEARTBEAT_MS` | `15000` | Heartbeat interval for open streams. |
| `SSE_MAX_STREAM_MS` | `1800000` | Maximum stream duration before it is closed (30 min). |

## Pagination, retention and audit

| Variable | Default | Description |
| --- | --- | --- |
| `DEFAULT_PAGE_SIZE` | `25` | Default page size for list endpoints. |
| `MAX_PAGE_SIZE` | `100` | Maximum page size. `DEFAULT_PAGE_SIZE` must not exceed it. |
| `RETAIN_MESSAGE_CONTENT` | `false` | Global default for message retention. Explicit opt-in. |
| `DEFAULT_RETENTION_DAYS` | `7` | Default retention window for new instances. |
| `MAX_RETENTION_DAYS` | `365` | Maximum retention window an instance may be set to. |
| `AUDIT_EVENTS_RETENTION_DAYS` | `90` | How long audit events are kept. |

`DEFAULT_RETENTION_DAYS` must be ≤ `MAX_RETENTION_DAYS`. If
`RETAIN_MESSAGE_CONTENT=true`, `DEFAULT_RETENTION_DAYS` must be > 0.

## Shutdown

| Variable | Default | Description |
| --- | --- | --- |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Hard cap on graceful shutdown before a forced exit. |

## Production fail-fast summary

With `NODE_ENV=production`, startup **fails** unless:

- `API_KEY_PEPPER` is ≥ 32 characters and not a placeholder;
- the encryption keyring is non-empty and contains `ENCRYPTION_KEY_ID`;
- `CORS_ORIGINS` is non-empty and does not contain `*`;
- enabling the web connector includes `WHATSAPP_WEB_AUTHORIZATION_REFERENCE`.

It **warns** (but starts) when:

- `DATA_DIR` is the default `./data`;
- the web connector uses the `local` (unencrypted-profile) strategy.

## Related

- [Getting started → Configure](./getting-started.md#3-configure)
- [Security](./security.md)
- [Deployment → Production checklist](./deployment.md#production-checklist)
