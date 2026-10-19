# Connectors

A connector is the adapter between the gateway's stable API and a specific
WhatsApp transport. Business logic never imports a WhatsApp library directly: it
talks to the interface in `src/connectors/connector.interface.js`.

Each connector truthfully advertises its real capabilities through
`getCapabilities()`. Any operation it does not genuinely support throws a
structured `CapabilityNotSupportedError` → **HTTP 501 `CAPABILITY_NOT_SUPPORTED`**
instead of returning invented data.

## The interface

Operations a connector may implement (unsupported ones default to
`CapabilityNotSupportedError`):

| Method | Purpose |
| --- | --- |
| `getCapabilities()` | Accurate capability descriptor (never aspirational). |
| `getStatus()` | `{ status, details, lastError?, qr? }`. |
| `initialize()` | Start/resume the session. |
| `requestQrAuth()` | Begin QR authentication. |
| `requestPairingCode(phone)` | Request a device-linking code. |
| `listChats()`, `getChat()`, `listMessages()`, `listContacts()` | Read-only data. |
| `sendMessage({ to, text })` | Send a text message. |
| `resetForReconnect()` | Tear down a half-open client before a supervised reconnect. |
| `disconnect({ logout })` | Stop the session. |
| `destroy()` | Release all resources. |

Capability keys: `qrAuth`, `pairingCode`, `listChats`, `getChat`,
`listMessages`, `listContacts`, `webhooks`, `outboundMessaging`,
`messageRecording`.

## Capability matrix

| Capability | `cloud_api` (default) | `web` (opt-in, disabled by default) |
| --- | --- | --- |
| Official WhatsApp API | ✅ | ❌ (explicitly not) |
| QR login | ❌ | ✅ |
| Phone-number pairing code | ❌ | ✅ |
| List chats | only recorded data | ✅ (linked device) |
| Get one chat | only with retention | ✅ |
| List messages | only recorded data | ✅ (bounded recent window) |
| List contacts | ❌ | ✅ (may be incomplete) |
| Full historical export | ❌ | ❌ (partial: recent only) |
| Webhooks | ✅ | ❌ |
| Outbound messaging | ✅ text (official) | ✅ text (non-official) |
| Message recording | inbound webhooks + gateway sends (retention-gated) | incoming + outgoing (live; retention-gated) |

Discover this from the API itself:

```bash
curl -s http://localhost:3000/api/v1/connectors -H "X-API-Key: $KEY"
```

---

## `cloud_api` — Official WhatsApp Business Platform

The default and the only connector suitable for production.

### What it genuinely does

- Verifies the configured business phone number with a documented Graph API call.
  "Connected" means **Meta accepts these credentials**.
- Receives inbound messages and message-status webhooks the business account is
  subscribed to (signature verification and de-duplication handled by
  `WebhookService`).
- Exposes recorded messages read-only (inbound webhook messages and outbound
  sends made through this API), only when the operator explicitly enabled
  retention for the instance.
- Sends outbound text messages through the official `/messages` endpoint.

### What it does not do (and never pretends to)

- No WhatsApp Web QR login or phone pairing.
- No full historical chat export.
- No arbitrary contact list.
- No navigation of personal chat history.

### Capability descriptor highlights

- `official: true`
- `qrAuth: false`, `pairingCode: false`, `listContacts: false`,
  `historicalMessages: false`
- `listChats`/`getChat`/`listMessages` = `retentionEnabled` for the instance
- `webhooks` = whether a verify token + app secret are configured
- `outboundMessaging` = whether credentials are configured (`configured`)
- `messageContentRetention`: `enabled` | `disabled`

### Status meaning

`status: "ready"` means Meta accepted the access token and phone-number id. When
credentials are missing, `initialize()` sets `error` and publishes a
**non-recoverable** error (reconnection cannot fix configuration).

### Reads require retention

Chat/message endpoints return `501 CAPABILITY_NOT_SUPPORTED` unless retention is
enabled for the instance. When enabled, they read only the inbound webhook
messages this gateway received and retained — outbound and pre-existing history
are unavailable.

### Configuration

```dotenv
DEFAULT_CONNECTOR=cloud_api
META_ACCESS_TOKEN=...
META_PHONE_NUMBER_ID=...
META_VERIFY_TOKEN=...      # for webhooks
META_APP_SECRET=...        # for webhook signature verification
META_API_VERSION=v21.0
META_GRAPH_BASE_URL=https://graph.facebook.com
```

### The Graph API client

`CloudApiClient` implements only the documented endpoints needed:
`getPhoneNumber()` and `sendTextMessage()`. Provider errors are mapped to a safe
subset (`providerCode`, `providerType`, a truncated `providerMessage`) — the raw
response and the access token are never returned to API clients or logged.

---

## `web` — Authorised WhatsApp Web (opt-in)

**Disabled by default.** Only constructed when the operator has set
`ENABLE_WHATSAPP_WEB_CONNECTOR=true` **and** recorded
`WHATSAPP_WEB_AUTHORIZATION_REFERENCE`. It is built on `whatsapp-web.js` +
Puppeteer and is explicitly **not an official WhatsApp API**.

### What it genuinely does

- QR login (`qrAuth`) and phone-number pairing (`pairingCode`).
- Read chats, a single chat, recent messages, and contacts from the linked device.
- Send a text message **as the linked account**.

### Honest limits

- Message history is limited to what the linked device can provide; there is no
  complete historical export (`historicalMessages: "partial: recent messages available on the linked device only"`).
- A running linked browser can read decrypted message content.
- Only one linked session per instance; cookies and profiles are never shared
  between instances.
- Outbound sends are text-only and reported as `sent` once the linked device
  hands the message to WhatsApp — **delivery is not independently confirmed**.
- No webhooks.

### Enabling it

```dotenv
ENABLE_WHATSAPP_WEB_CONNECTOR=true
WHATSAPP_WEB_AUTHORIZATION_REFERENCE=CONTRACT-2026-00042
WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted
```

Enabling without the authorization reference is a **fatal** configuration error.

### Session strategies

| Strategy | Storage | Encryption at rest |
| --- | --- | --- |
| `local` (default) | `whatsapp-web.js` `LocalAuth` Chromium profile directory | **Not** encrypted by this service — relies on the hosting volume |
| `remote_encrypted` | `RemoteAuth` archive encrypted via `EncryptedSessionStore` | AES-256-GCM before it is written; only ciphertext on disk |

In production, `local` produces a warning. The gateway **never claims** the live
browser profile is encrypted just because JSON files are.

Per-instance session directory: `DATA_DIR/instances/<id>/session` (`0700`).
Encrypted archive: `session-archive.enc` + `session-archive.meta.json`.

### Pairing-code caveat (whatsapp-web.js v1.34.x)

`whatsapp-web.js` only honours the constructor `pairWithPhoneNumber` option.
Calling `requestPairingCode()` on a client built for QR throws in this version.
The connector therefore **rebuilds the client in pairing mode** instead of
calling it from the `qr` handler. A still-valid code is reused unless `force` is
set.

### Chat and message reads on current WhatsApp Web builds

`whatsapp-web.js` 1.34.7 builds each chat through `getChatModel()`, which runs
`chat.serialize()`. Current WhatsApp Web builds renamed an internal message-key
field (`_serialized` → `$1`) and changed group-metadata handling, which makes
that call throw for some chats. As a result the library's `getChats()` and
`getChatById()` reject as a whole with an opaque single-letter error (`r`), even
though the linked session is healthy.

The connector does **not** rely on those methods for reads. It reads the same
page store the library reads, one chat/message at a time and only primitive
fields, so a chat that cannot be serialised is skipped instead of failing the
whole request. If the page is unavailable the connector falls back to the
library API. This is a compatibility workaround for a library bug, not a
platform restriction being circumvented; it is removed once the upstream fix
lands in a released `whatsapp-web.js`.

### Sending to a chat id

A WhatsApp Web send must address the exact chat. Modern WhatsApp uses LID-based
ids (`...@lid`) for direct chats as well as phone-number ids (`...@c.us`), so
the connector sends to whatever `to` it is given: a bare phone number is treated
as `<number>@c.us`, and a full chat id is passed through unchanged. Rewriting a
LID to a phone number would address the wrong chat.

### Browser security

`BrowserManager` enforces:

- admission control (`MAX_BROWSER_INSTANCES`),
- **one browser per instance** (a second init is rejected, not launched),
- deterministic teardown on disconnect, crash and shutdown,
- Chromium's **sandbox enabled by default** — it is only disabled when the
  operator explicitly sets `WHATSAPP_WEB_NO_SANDBOX=true` on hosts that block
  unprivileged user namespaces, and **no remote-debugging port** is set.

Launch flags are conservative (`--disable-dev-shm-usage`, `--disable-extensions`,
`--no-first-run`, `--disable-background-networking`, `--disable-sync`, ...). There
are **no stealth/anti-detection plugins** and no attempts to defeat platform
restrictions.

If Chromium fails with `No usable sandbox!` on Ubuntu 23.10+ or inside a
container, the secure fixes are to enable the SUID sandbox or grant the required
container capability. `WHATSAPP_WEB_NO_SANDBOX=true` is a development-only
fallback; it weakens browser isolation and should not be the default in
production.

### Chat id validation

Chat ids match `^[A-Za-z0-9@._-]{5,80}$`; an invalid id is rejected before
anything is looked up.

---

## Discovery and truthfulness

`describeSupportedEndpoints(capabilities)` maps capabilities to the endpoints a
connector can genuinely serve:

```
GET  /api/v1/instances/:instanceId/status                       → always true
POST /api/v1/instances/:instanceId/connect/qr                   → qrAuth
POST /api/v1/instances/:instanceId/connect/pairing-code         → pairingCode
GET  /api/v1/instances/:instanceId/auth/events                  → always true
GET  /api/v1/instances/:instanceId/chats                        → listChats
GET  /api/v1/instances/:instanceId/chats/:chatId                → getChat
GET  /api/v1/instances/:instanceId/chats/:chatId/messages       → listMessages
GET  /api/v1/instances/:instanceId/contacts                     → listContacts
POST /api/v1/messages/send                                      → outboundMessaging
```

## Production guidance

Use the **official WhatsApp Business Platform** for production business
messaging. The web connector is a narrowly-scoped, authorisation-gated option and
carries the linked account's own risk.

## Related

- [Connection lifecycle](./connection-lifecycle.md)
- [Outbound messaging](./outbound-messaging.md)
- [Configuration → Connectors](./configuration.md#connectors)
