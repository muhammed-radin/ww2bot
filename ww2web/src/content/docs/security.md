# Security

This service is private and single-owner. The security properties below are
enforced in code and covered by tests under `tests/security/` and
`tests/integration/`.

## Threat model and boundaries

- **Single owner.** One owner (you) controls authentication, credentials and
  instance lifecycle. The RazorBills backend gets a narrowly scoped key that can
  only do what its integration needs.
- **No multi-tenancy.** There is no registration, no public auth page and no
  customer accounts.
- **No self-service linking.** There is no endpoint by which an unknown party can
  link a WhatsApp account. QR/pairing challenges are delivered only to the
  authenticated owner who requested them, while they are current, and are never
  cached or logged.
- **Host access is the root of trust.** The CLI that bootstraps the first owner
  key uses the configured pepper and data directory directly; whoever can run it
  already holds the privileges that matter.

## Credential handling

### API keys

- Read **only** from the `X-API-Key` header — never from a query string or path,
  so keys cannot leak into access logs, proxies, referrers or history.
- 256 bits of CSPRNG entropy; format `wak_<18 hex>_<43 base64url>`.
- Stored only as an HMAC-SHA256 digest keyed with `API_KEY_PEPPER`.
- The plaintext is returned **exactly once** at creation/rotation.
- Constant-time comparison during verification; failure reasons are audited, not
  returned.
- Lookup is by the non-secret key id.

### Secrets that must never be persisted or logged

- QR payloads and data URLs.
- Pairing codes.
- Cookies, localStorage, session files and archive plaintext.
- The access token and app secret.

The logger redacts `req.headers["x-api-key"]`, `authorization`, `cookie`,
`set-cookie`, `apiKey`, `password`, `token`, `pairingCode`, `qr`, `qrDataUrl`,
`sessionData`, `cookies` (and nested `*.` variants). Query strings carrying a
`streamToken` are scrubbed before logging.

## Encryption at rest

AES-256-GCM (`src/services/encryption.service.js`):

- Format `ENC:v1:<keyId>:<iv>:<tag>:<ciphertext>` (base64url).
- Each ciphertext records the key id used, so keys can be rotated without losing
  the ability to read existing data.
- GCM gives confidentiality **and** integrity: a modified ciphertext fails to
  decrypt rather than returning attacker-controlled plaintext.
- Optional Additional Authenticated Data binds a ciphertext to its logical
  location (for example a message id), preventing cut-and-paste between rows.
- A keyring (`ENCRYPTION_KEYS` inline or `ENCRYPTION_KEYS_FILE`) holds one or more
  32-byte keys; `ENCRYPTION_KEY_ID` selects the active one.

Encrypted: session archives (`remote_encrypted`), retained message bodies,
delivery recipients.

> **Not claimed to be encrypted:** the live Chromium browser profile used by the
> web connector's `local` strategy. That is the hosting volume's responsibility.
> Use `remote_encrypted` or an encrypted volume. The gateway never claims the
> browser profile is encrypted just because JSON files are.

> This is encryption of data the gateway legitimately handles. It is **not**,
> and must never be described as, end-to-end encryption of WhatsApp traffic.

## Authorization

- Granular scopes: `messages:send`, `instances:read`, `connection:read`,
  `data:read`, `audit:read` (integration-friendly) and `auth:manage`,
  `keys:manage` (owner-only), plus `*`.
- **No privilege escalation.** A non-wildcard actor cannot grant a scope it does
  not hold; only a wildcard actor may mint a wildcard key; a key can only manage
  keys in its own tenant.
- **No unrestricted key creation.** Creating any key requires owner-only
  `keys:manage`.
- **Tenant isolation.** Cross-tenant access returns 404, never 403, so resource
  existence cannot be probed. Keys may additionally be restricted to an
  `allowedInstanceIds` allowlist.

See [Authentication](./authentication.md).

## HTTP hardening

`src/middleware` + `src/config/security.js`:

- **Helmet** with an API-service content-security policy (`default-src 'none'`,
  no framing, no forms), `same-site` cross-origin resource policy,
  `no-referrer`, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff`, and `x-powered-by` disabled.
- **CORS**: an origin allowlist; `*` is rejected in production. Requests without
  an `Origin` header (server-to-server) are allowed.
- **Body limit**: `BODY_LIMIT` (default 100kb), strict JSON.
- **IP allowlist**: optional, applied before any parsing or routing.
- **Rate limits**: per key **and** per IP (composed key), plus per-recipient send
  limits.
- **Request ids**: accepted (bounded) or generated, echoed, and included in
  errors.
- **Central error handling**: one safe shape, no internals.
- **JSON escaping**: `app.set('json escape', true)`.
- Slowloris protection: bounded `headersTimeout` / `requestTimeout`.
- **Timezone/URL hygiene**: credentials in URLs are scrubbed from logs.

### Dashboard (`/ui/`, `/frontend/`)

The bundled administration dashboard is served by the same process under a
**narrower, same-origin policy of its own** (`uiHelmetOptions`): `script-src
'self'` with no `unsafe-inline` and no `unsafe-eval`, `style-src 'self'
'unsafe-inline'`, `img-src 'self' data: blob:` (the QR code is a data URL),
`connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action
'none'`, and `frame-ancestors 'none'`. Only `public/frontend/` is reachable
through `express.static` with `index: false` and `dotfiles: "deny"`; a missing
asset is a JSON `404`. The JSON API keeps its stricter `default-src 'none'`
policy.

The dashboard never receives secrets, never stores them, and never persists
short-lived credentials (QR payloads, pairing codes, the CSRF token) — see
[Owner dashboard](./admin-dashboard.md#security-rules-the-ui-follows).

## Browser security (web connector)

When the opt-in web connector is enabled:

- Runs as a **non-root** user (the container's `node` user).
- Chromium's **sandbox is enabled by default**. It is only disabled
  (`--no-sandbox`) when the operator explicitly sets
  `WHATSAPP_WEB_NO_SANDBOX=true` on a host that blocks unprivileged user
  namespaces; that fallback weakens isolation and is never the default.
- **No remote-debugging port** is exposed. Chromium is launched without
  `--remote-debugging-port`.
- Profiles are isolated per instance (`0700`), never shared between instances.
- Cookies, localStorage, tokens and session files are **never returned via the
  API**.
- No stealth/anti-detection plugins and no attempts to bypass platform
  restrictions.
- Admission control (`MAX_BROWSER_INSTANCES`) and one browser per instance.
- Graceful teardown on disconnect, crash and shutdown.

## Outbound safety

- Recipient/content validation; text only.
- Per-key, per-IP and per-recipient limits.
- Idempotency keys (hashed, never stored raw).
- Minimum delivery metadata.
- **No auto-retry of ambiguous deliveries** (which could duplicate a message).
- Honest statuses `accepted | sent | failed | unknown`, never a false delivery
  claim.

## Failure handling

- **Fail fast on bad configuration** in production (pepper, keyring, CORS, web
  authorization reference).
- **Fail fast on unusable storage**: one clear `SERVICE_UNAVAILABLE` error,
  never a half-working service that would silently discard sessions.
- **Corruption tolerance**: unreadable files are quarantined, never trusted.
- **Atomic writes and locks** so an interrupted operation cannot corrupt state or
  start a duplicate browser.

## Reporting a vulnerability

The project is private and unlicensed. Report security issues directly to the
maintainer; do not open a public issue.

## Related

- [Authentication](./authentication.md)
- [Owner dashboard](./admin-dashboard.md)
- [Storage](./storage.md)
- [Data retention and privacy](./data-retention.md)
- [Deployment → Production checklist](./deployment.md#production-checklist)
