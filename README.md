# razorbills-whatsapp

A private, single-owner WhatsApp service for the **RazorBills** backend.

It exposes a small, auditable HTTP API over WhatsApp and ships **two
connectors**:

- **Official WhatsApp Business Platform (Cloud API)** — the **default** and the
  only connector suitable for production. It verifies the operator's credentials
  against Meta, receives inbound messages and statuses through signed webhooks,
  and sends outbound messages through the official `/messages` endpoint.
- **Authorised WhatsApp Web connector** — **disabled by default** and gated
  behind a written-authorization reference. It is built on `whatsapp-web.js` and
  is explicitly *not* an official WhatsApp API.

The design goal is honesty: the API reports exactly what a connector can do and
never invents data or fakes capability.

**This is not a multi-tenant product.** There is no registration, no public auth
page and no customer accounts. Only one owner (you) may initialise WhatsApp
authentication, view a QR code, request a pairing code, disconnect, or manage
credentials; the RazorBills backend gets a narrowly scoped key that can only do
what its integration needs.

**There is no database and no Redis.** All state is stored as files under
`DATA_DIR`. See [the data directory](#8-the-data-directory).

---

## Table of contents

1. [Overview](#1-overview)
2. [Security model](#2-security-model)
3. [Architecture](#3-architecture)
4. [Requirements](#4-requirements)
5. [Quick start](#5-quick-start)
6. [Configuration](#6-configuration)
7. [Connectors and capabilities](#7-connectors-and-capabilities)
8. [The data directory](#8-the-data-directory)
9. [API keys, scopes and owner-only controls](#9-api-keys-scopes-and-owner-only-controls)
10. [Connection state and automatic reconnection](#10-connection-state-and-automatic-reconnection)
11. [Outbound messaging (RazorBills)](#11-outbound-messaging-razorbills)
12. [API reference](#12-api-reference)
13. [Real-time authentication events (SSE)](#13-real-time-authentication-events-sse)
14. [Cloud API webhooks](#14-cloud-api-webhooks)
15. [Read-only data API and retention](#15-read-only-data-api-and-retention)
16. [Pagination](#16-pagination)
17. [Errors](#17-errors)
18. [Health and observability](#18-health-and-observability)
19. [Testing](#19-testing)
20. [Docker and deployment](#20-docker-and-deployment)
21. [Administration dashboard (ww2web)](#21-administration-dashboard-ww2web)
22. [Backup, restore, permissions and secure deletion](#22-backup-restore-permissions-and-secure-deletion)
23. [Operations and production checklist](#23-operations-and-production-checklist)
24. [License](#24-license)

---

## 1. Overview

- **Node.js ESM** (no build step) and **Express 5**.
- **One authoritative API** for instances, connection state, read-only message
  data, outbound sends and an audit trail.
- **File-based storage only.** Every piece of state is a JSON/JSONL file or a
  binary blob under `DATA_DIR`. Writes are atomic (temp file + flush + rename)
  and per-file updates are serialised with an in-process mutex; per-instance
  operations are serialised with a file lock that survives crashes safely.
- **Single owner.** One process, one tenant. Owner-only controls (authentication,
  credential management) are separated from the narrow integration scopes used
  by the RazorBills backend.
- **No business logic in route handlers.** Connectors, storage, security and
  orchestration are separate modules.

## 2. Security model

The security properties below are enforced in code and covered by tests under
`tests/security/` and `tests/integration/`.

- **API-key authentication via the `X-API-Key` header only.** A key is **never**
  accepted in a query string or path. This keeps keys out of access logs,
  proxies and browser history.
- **Key storage.** A key is `wak_<keyId>_<secret>` where `<secret>` is 32 random
  bytes (base64url). Only a **pepper-keyed HMAC-SHA-256 digest** is stored. The
  plaintext is returned **exactly once**, at creation.
- **Scopes and rotation.** Keys carry granular scopes (`messages:send`,
  `instances:read`, `connection:read`, `data:read`, `audit:read`, `auth:manage`,
  `keys:manage`). Rotation issues a new secret and revokes the old one; revocation
  is immediate. **A key can never grant a scope it does not itself hold**, and
  only a wildcard (`*`, owner) key may mint another wildcard key.
- **Owner-only controls.** `auth:manage` (initialise/disconnect/QR/pairing/
  session/data purge) and `keys:manage` (key administration) are reserved for the
  owner. The RazorBills backend key is created with `messages:send` (and
  optionally `instances:read`) only.
- **No self-service linking.** There is no endpoint by which an unknown party can
  link a WhatsApp account. QR/pairing challenges are delivered only to the
  authenticated owner who asked for them, and only while they are current.
- **Single-owner tenant guard.** Every resource is scoped to one internal tenant
  id (`DEFAULT_TENANT_ID`). Reading another tenant's resource returns **404,
  never 403**, so a key holder cannot probe for the existence of foreign
  resources. Keys may additionally be restricted to an allowlist of instance ids.
- **Encryption at rest (AES-256-GCM).** Stored session archives, message bodies
  and delivery recipients are encrypted with a keyring (`ENCRYPTION_KEYS` /
  `ENCRYPTION_KEYS_FILE`). Old keys stay in the ring so old ciphertext still
  decrypts.
  > The **live Chromium browser profile** used by the web connector's `local`
  > strategy is **not** encrypted by this service — that is the responsibility of
  > the hosting volume. Use `WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted`, or an
  > encrypted volume, and read
  > [§21](#21-backup-restore-permissions-and-secure-deletion).
- **Secrets never leak.** QR payloads, pairing codes, cookies and session
  material are never written to logs or to disk in plaintext. Log fields are
  redacted, and URLs are scrubbed of credential query parameters before logging.
- **HTTP hardening.** Helmet security headers, a CORS allowlist, an optional
  source-IP allowlist, strict JSON body limits, per-key **and** per-IP rate
  limits, request ids, and a central error handler that emits
  `{success:false,error:{code,message},requestId}` with no stack traces or
  filesystem paths.
- **No stealth or bypasses.** The web connector does not attempt to defeat
  platform restrictions. Chromium's sandbox is enabled by default (it can only
  be disabled by explicitly setting `WHATSAPP_WEB_NO_SANDBOX=true` on hosts
  without user namespaces), and there is no remote-debugging port.

## 3. Architecture

```
src/
  app.js            Express assembly (middleware order, route mounting)
  server.js         Process entry point, graceful shutdown
  container.js      Composition root — every dependency wired explicitly
  config/           env parsing/validation, security policy (scopes, route map)
  middleware/       auth, rate limits, validation, ip allowlist, request id, errors
  routes/           thin HTTP handlers
  services/         business logic (instances, keys, sessions, outbound,
                    connection state, reconnection, retention, ...)
  connectors/       connector interface + cloudApi + web implementations
  storage/          file store, validated paths, per-file mutex, per-instance lock
  repositories/     file-backed repositories over the storage primitives
  events/           in-process event bus for SSE and internal supervisors
  utils/            errors, logger, ids, pagination, responses
  validators/       zod schemas
scripts/            API-key administration + data-purge CLIs
tests/              unit, integration, security, live
```

The `connectors/connector.interface.js` contract defines the operations a
connector may support. Each connector advertises its real capabilities via
`getCapabilities()`, and unsupported operations return
`CAPABILITY_NOT_SUPPORTED` (HTTP 501) instead of fabricated data.

## 4. Requirements

- **Node.js ≥ 20.11** (developed and tested on Node 22/24).
- A **persistent, access-restricted volume** mounted at `DATA_DIR`. There is no
  database and no Redis.
- For the web connector only: the optional `whatsapp-web.js` + `puppeteer`
  dependencies and a host able to run Chromium.

## 5. Quick start

```bash
# 1. Install dependencies (skip the optional browser stack)
npm install --omit=optional

# 2. Configure
cp .env.example .env
#    Generate a pepper and an encryption key, then edit .env:
node -e "console.log('API_KEY_PEPPER=' + require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('ENCRYPTION_KEYS={\"k1\":\"' + require('crypto').randomBytes(32).toString('base64') + '\"}')"

# 3. Start (the data directory is created on first run)
npm start

# 4. Create the first OWNER key (printed once). Owner keys hold `auth:manage`
#    and `keys:manage`, so they can initialise WhatsApp and create more keys.
npm run key:create -- --preset owner --name owner

# 5. Create the narrow RazorBills key (messages:send only)
npm run key:create -- --preset service --name razorbills
```

The service listens on `http://localhost:3000`. Check it:

```bash
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

## 6. Configuration

All configuration is environment-driven and validated at startup.
[`.env.example`](.env.example) is the source of truth; the most important
variables are summarised here.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL` | Runtime |
| `DATA_DIR` | **The only stateful dependency.** All keys, instances, connection state, sessions, deliveries and audit events live here. |
| `DEFAULT_TENANT_ID` | Internal single-owner tenant id (`default`). Do not change after instances exist. |
| `API_KEY_PEPPER` (≥ 32 chars) | HMAC pepper for key storage |
| `API_KEY_DEFAULT_TTL_DAYS` | Default key lifetime (`0` = never) |
| `ENCRYPTION_KEY_PROVIDER`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS`, `ENCRYPTION_KEYS_FILE` | AES-256-GCM keyring |
| `DEFAULT_CONNECTOR` | `cloud_api` (default) or `web` |
| `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_API_VERSION`, `META_GRAPH_BASE_URL` | Official Cloud API |
| `ENABLE_WHATSAPP_WEB_CONNECTOR`, `WHATSAPP_WEB_AUTHORIZATION_REFERENCE`, `WHATSAPP_WEB_AUTH_STRATEGY`, `WHATSAPP_WEB_HEADLESS`, `WHATSAPP_WEB_PAIRING_INTERVAL_MS`, `WHATSAPP_WEB_LAUNCH_TIMEOUT_MS` | Authorised web connector |
| `AUTO_RECONNECT_ON_STARTUP`, `RECONNECT_ENABLED`, `RECONNECT_BASE_DELAY_MS`, `RECONNECT_MAX_DELAY_MS`, `RECONNECT_MAX_ATTEMPTS`, `RECONNECT_MAX_DURATION_MS`, `RECONNECT_JITTER`, `RECONNECT_STABLE_RESET_MS` | Recovery after a drop/restart |
| `OUTBOUND_MESSAGING_ENABLED`, `IDEMPOTENCY_TTL_MS`, `DELIVERY_METADATA_RETENTION_DAYS` | Outbound messaging |
| `CORS_ORIGINS`, `TRUST_PROXY`, `BODY_LIMIT`, `IP_ALLOWLIST` | HTTP security |
| `RATE_LIMIT_*` | Rate limits (per key + per IP; send and per-recipient limits too) |
| `MAX_BROWSER_INSTANCES`, `QR_TTL_MS` | Browser/instance limits |
| `STREAM_TOKEN_TTL_MS`, `SSE_HEARTBEAT_MS`, `SSE_MAX_STREAM_MS` | Event streams |
| `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` | Pagination |
| `RETAIN_MESSAGE_CONTENT`, `DEFAULT_RETENTION_DAYS`, `MAX_RETENTION_DAYS`, `AUDIT_EVENTS_RETENTION_DAYS` | Retention |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown |

**Production fail-fast.** With `NODE_ENV=production`, startup **fails** unless:
`API_KEY_PEPPER` is ≥ 32 characters and not a placeholder, `CORS_ORIGINS` is
non-empty and not `*`, and the encryption keyring is non-empty. Enabling the web
connector without `WHATSAPP_WEB_AUTHORIZATION_REFERENCE` also fails on purpose.
Using the default `DATA_DIR=./data` in production is allowed but produces a
warning, because that directory must be a persistent, access-restricted volume.

The service **also fails fast** if `DATA_DIR` cannot be created or written: you
get one clear `SERVICE_UNAVAILABLE` error mentioning `DATA_DIR` instead of a
half-working service that silently discards sessions.

## 7. Connectors and capabilities

| Capability | `cloud_api` (default) | `web` (opt-in, disabled by default) |
| --- | --- | --- |
| Official WhatsApp API | ✅ | ❌ (explicitly not) |
| QR login | ❌ | ✅ |
| Phone-number pairing code | ❌ | ✅ |
| List chats | only retained inbound data | ✅ (linked device) |
| List messages | only retained inbound data | ✅ (bounded recent window) |
| List contacts | ❌ | ✅ (may be incomplete) |
| Full historical export | ❌ | ❌ (partial: recent only) |
| Webhooks | ✅ | ❌ |
| Outbound messaging | ✅ text (official) | ✅ text (non-official) |

Discover this from the API itself:

```bash
curl -s http://localhost:3000/api/v1/connectors -H "X-API-Key: $API_KEY"
```

Requesting an unsupported operation returns `501 CAPABILITY_NOT_SUPPORTED` with
an explanation — the gateway never fabricates a response.

> The official WhatsApp Business Platform does **not** support Web QR
> authentication or arbitrary chat-history extraction, and this service never
> claims it does. For production business messaging use the Cloud API.

**Enabling the web connector** requires that you hold the written authorization
for the exact intended use:

```bash
ENABLE_WHATSAPP_WEB_CONNECTOR=true
WHATSAPP_WEB_AUTHORIZATION_REFERENCE=CONTRACT-2026-00042
WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted
```

## 8. The data directory

Everything the service persists lives under `DATA_DIR` (default `./data`):

```
data/
  config/
    service.json            # non-secret service metadata (schema version, ...)
  api-keys/
    keys.json               # key digests only (pepper-keyed HMAC), metadata
  instances/
    ins_<32 hex>/
      instance.json         # instance metadata (connector, retention, ...)
      connection.json       # the persisted connection state machine
      session/              # browser profile (local strategy) — 0700
      session-archive.enc   # encrypted session archive (remote_encrypted)
      session-archive.meta.json
      messages.jsonl        # retained inbound messages (bodies encrypted)
      webhook-events.jsonl  # webhook de-duplication ledger
      deliveries.jsonl      # outbound idempotency + minimal delivery metadata
  audit/
    events.jsonl            # append-only security/operational audit trail
  locks/
    <hash>.lock             # per-instance operation locks (no secrets)
  tmp/                      # transient scratch; swept on startup
```

Storage guarantees:

- **Atomic writes.** Data is written to a uniquely named temp file in the same
  directory, flushed (`fsync`), then renamed over the target. A reader never sees
  a half-written file; an interrupted write leaves either the old file or the new
  one.
- **Serialised updates.** A keyed in-process mutex serialises read-modify-write
  cycles for the same file, so two concurrent requests cannot lose an update.
  JSONL files support the same via `updateJsonl`.
- **Corruption tolerance.** A file that cannot be parsed or fails its schema
  check is renamed aside (`.corrupt-<timestamp>`) and reported; the caller gets
  the documented fallback instead of a crash. A missing file is not an error.
- **Restrictive permissions.** Directories are created `0700` and files `0600`.
- **Validated paths.** Every path is derived from an already-validated internal
  id and asserted to stay inside `DATA_DIR`; a crafted id can never escape it.
- **Locks are never stolen just because they look old.** A lock file records the
  owning pid; it is reclaimed only after verifying that the owning process is
  actually gone (or, for this process, that the in-memory owner no longer holds
  the token). Stale locks are swept at startup.

One process owns each instance. Run **a single service process**; do not run
multiple replicas against the same `DATA_DIR` (cross-process coordination is not
implemented).

## 9. API keys, scopes and owner-only controls

Scopes:

| Scope | Grants | Who |
| --- | --- | --- |
| `messages:send` | send outbound messages | RazorBills backend |
| `instances:read` | read instances, status, capabilities, session, retention | RazorBills backend (optional) |
| `connection:read` | read live connection status, issue stream tokens, open event streams | RazorBills backend (optional) |
| `data:read` | read chats, messages, contacts | owner |
| `audit:read` | read the audit trail | owner |
| `auth:manage` | initialise/disconnect, QR/pairing, delete session, purge data | **owner only** |
| `keys:manage` | create/list/rotate/revoke API keys | **owner only** |
| `*` | every scope (owner) | **owner only** |

Create, list, rotate and revoke keys:

```bash
# Create (plaintext shown once). A limited actor may only grant scopes it holds.
curl -s -X POST http://localhost:3000/api/v1/api-keys \
  -H "X-API-Key: $OWNER_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"razorbills","scopes":["messages:send"]}'

# List (digests are never returned)
curl -s http://localhost:3000/api/v1/api-keys -H "X-API-Key: $OWNER_KEY"

# Rotate (revokes the old secret)
curl -s -X POST http://localhost:3000/api/v1/api-keys/$KEY_ID/rotate -H "X-API-Key: $OWNER_KEY"

# Revoke (immediate)
curl -s -X DELETE http://localhost:3000/api/v1/api-keys/$KEY_ID -H "X-API-Key: $OWNER_KEY"
```

There is **no unrestricted key-creation endpoint**: creating a key with
`keys:manage` is itself an owner action, and a non-owner key can never escalate
itself or mint a wildcard key. A key may be restricted to specific instances:

```json
{ "name": "razorbills", "scopes": ["messages:send"], "allowedInstanceIds": ["ins_ab12…"] }
```

## 10. Connection state and automatic reconnection

Each instance has an explicit, persisted state machine:

```
DISCONNECTED → INITIALIZING → QR_REQUIRED → AUTHENTICATING → CONNECTED
                               ↘ RECONNECTING ↗
                                        ↘ ERROR (needs the owner)
```

- The state (plus attempt counter, timestamps and a **redacted** last-error
  string) is written to `connection.json` on every transition, so it survives a
  restart. It never contains QR payloads, pairing codes or session material.
- On a **recoverable** disconnect/error the supervisor schedules a reconnect with
  **exponential backoff + random jitter**, bounded by `RECONNECT_MAX_DELAY_MS`,
  `RECONNECT_MAX_ATTEMPTS` and `RECONNECT_MAX_DURATION_MS`. Exhausting a bound
  moves the instance to a visible **ERROR** and stops — there is no infinite
  rapid reconnect loop.
- A connection that stays healthy for `RECONNECT_STABLE_RESET_MS` resets the
  attempt counter.
- On startup, previously-live instances are handled per policy:
  **`cloud_api`** instances are reconnected automatically (if
  `AUTO_RECONNECT_ON_STARTUP=true`); **web** instances are marked
  `DISCONNECTED` and require the owner to re-initialise, so a restart never
  produces an unsolicited QR code.

Only one browser may own an instance at a time. Starting an already-active
session returns the current status instead of launching a second browser, and
concurrent initialisations are serialised by the per-instance lock.

## 11. Outbound messaging (RazorBills)

`POST /api/v1/messages/send` sends one text message:

```bash
curl -s -X POST http://localhost:3000/api/v1/messages/send \
  -H "X-API-Key: $RAZORBILLS_KEY" -H 'Content-Type: application/json' \
  -d '{"instanceId":"ins_…","to":"15551234567","text":"Your invoice is ready","idempotencyKey":"order-42"}'
# -> { "data": { "status": "accepted", "instanceId": "ins_…", "to": "15551234567",
#                "idempotent": false, "providerMessageId": "wamid.…" } }
```

Rules:

- **Scope:** `messages:send` only. Inputs are validated (recipient format, text
  length, `type` must be `text`).
- **Idempotency.** Pass `idempotencyKey` in the body or an `Idempotency-Key`
  header. Retrying with the same key within `IDEMPOTENCY_TTL_MS` returns the
  original result with `"idempotent": true` and does **not** send again.
- **Honest status.** The result is exactly what the connector can verify:
  `accepted` (Cloud API accepted the request — **not** proof of delivery),
  `sent` (web connector confirmed the library call), `failed`, or `unknown`.
  Final delivery is confirmed by Cloud API webhook status events. **The gateway
  never auto-retries an ambiguous send**, because that could duplicate a message.
- **Rate limits.** Per key **and** per IP (`RATE_LIMIT_SEND_*`), plus a
  per-recipient limit (`RATE_LIMIT_RECIPIENT_*`).
- **Minimum metadata.** Only the idempotency digest, a redacted recipient
  (encrypted at rest) and the outcome are stored in `deliveries.jsonl`, bounded
  by `DELIVERY_METADATA_RETENTION_DAYS`.
- **No scraping, no bulk unsolicited messaging, no contact collection.** Use the
  official WhatsApp Business Platform for production business messaging.

## 12. API reference

Base path: `/api/v1`. Unless noted, every route needs `X-API-Key` with the
listed scope. `:instanceId` matches `^ins_[a-f0-9]{32}$`.

### Instances

| Method | Path | Scope |
| --- | --- | --- |
| `POST` | `/instances` | `auth:manage` |
| `GET` | `/instances` | `instances:read` |
| `GET` | `/instances/:instanceId` | `instances:read` |
| `GET` | `/instances/:instanceId/status` | `connection:read` |
| `GET` | `/instances/:instanceId/capabilities` | `instances:read` |
| `POST` | `/instances/:instanceId/connect/qr` | `auth:manage` |
| `POST` | `/instances/:instanceId/connect/pairing-code` | `auth:manage` |
| `POST` | `/instances/:instanceId/disconnect` | `auth:manage` |
| `GET` | `/instances/:instanceId/session` | `instances:read` |
| `DELETE` | `/instances/:instanceId/session` | `auth:manage` |
| `GET` | `/instances/:instanceId/retention` | `instances:read` |
| `PUT` | `/instances/:instanceId/retention` | `auth:manage` |
| `POST` | `/instances/:instanceId/data/purge` | `auth:manage` |
| `GET` | `/instances/:instanceId/audit-events` | `audit:read` |
| `DELETE` | `/instances/:instanceId` | `auth:manage` |

### Data (read-only)

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/instances/:instanceId/chats` | `data:read` |
| `GET` | `/instances/:instanceId/chats/:chatId` | `data:read` |
| `GET` | `/instances/:instanceId/chats/:chatId/messages` | `data:read` |
| `GET` | `/instances/:instanceId/contacts` | `data:read` |

### Outbound

| Method | Path | Scope |
| --- | --- | --- |
| `POST` | `/messages/send` | `messages:send` |

### Authentication events

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/instances/:instanceId/auth/stream-token` | `X-API-Key` (`connection:read`) |
| `GET` | `/instances/:instanceId/auth/events` | `X-API-Key` header (`connection:read`) **or** single-use `?streamToken=` |

### Connectors and keys

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/connectors` | `instances:read` |
| `POST` | `/api-keys` | `keys:manage` |
| `GET` | `/api-keys` | `keys:manage` |
| `GET` | `/api-keys/:keyId` | `keys:manage` |
| `POST` | `/api-keys/:keyId/rotate` | `keys:manage` |
| `DELETE` | `/api-keys/:keyId` | `keys:manage` |

### Example: create a Cloud API instance and verify credentials

```bash
# Create (owner key)
curl -s -X POST http://localhost:3000/api/v1/instances \
  -H "X-API-Key: $OWNER_KEY" -H 'Content-Type: application/json' \
  -d '{"connector":"cloud_api","displayName":"Acme support","retentionEnabled":true,"retentionDays":7}'
# -> { "data": { "instance": { "id": "ins_…", … }, "capabilities": { … } } }

# Verify the Cloud API credentials (for cloud_api this "connect" performs the
# documented Graph API phone-number check; there is no QR)
curl -s -X POST http://localhost:3000/api/v1/instances/$INSTANCE_ID/connect/qr \
  -H "X-API-Key: $OWNER_KEY"
# -> { "data": { "status": "ready", "capabilities": { … } } }

# Read the live status (connection:read)
curl -s http://localhost:3000/api/v1/instances/$INSTANCE_ID/status -H "X-API-Key: $RAZORBILLS_KEY"
```

### Example: connect the authorised web connector (QR)

```bash
curl -s -X POST http://localhost:3000/api/v1/instances/$INSTANCE_ID/connect/qr \
  -H "X-API-Key: $OWNER_KEY"
# -> { "data": { "status": "awaiting_qr", "qr": { "qrDataUrl": "data:image/png;base64,…", "expiresAt": "…" } } }
```

QR and pairing challenges are returned **only** to the authenticated owner who
requested them, expire promptly (`QR_TTL_MS`), and are never cached or logged.

### Example: pairing code instead of QR

```bash
curl -s -X POST http://localhost:3000/api/v1/instances/$INSTANCE_ID/connect/pairing-code \
  -H "X-API-Key: $OWNER_KEY" -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"919812345678"}'
# -> { "data": { "pairingCode": "ABCD1234", "expiresAt": "…" } }
```

### Example: read chats and messages

```bash
curl -s "http://localhost:3000/api/v1/instances/$INSTANCE_ID/chats?limit=25" \
  -H "X-API-Key: $OWNER_KEY"

curl -s "http://localhost:3000/api/v1/instances/$INSTANCE_ID/chats/919812345678%40c.us/messages?limit=25&direction=inbound" \
  -H "X-API-Key: $OWNER_KEY"
```

Every data response includes a `limitations` array describing what the selected
connector genuinely cannot provide.

## 13. Real-time authentication events (SSE)

Browser `EventSource` cannot send a header, and a long-lived API key must never
be placed in a URL. Instead, exchange the key for a **single-use** stream token
and pass *that* in the query string:

```bash
# 1. Issue a stream token (connection:read)
curl -s -X POST http://localhost:3000/api/v1/instances/$INSTANCE_ID/auth/stream-token \
  -H "X-API-Key: $OWNER_KEY"
# -> { "data": { "token": "…", "expiresAt": "…", "singleUse": true, "eventsEndpoint": "…" } }

# 2. Open the stream (token is consumed on use)
curl -N "http://localhost:3000/api/v1/instances/$INSTANCE_ID/auth/events?streamToken=$STREAM_TOKEN"
```

The stream carries `stream.ready`, `qr`, `pairing_code`, `authenticated`,
`status`, `connection.state`, `connection.reconnecting`, `error`, `disconnected`
and `metric` events. Hardening: the token is single-use, bound to one instance
and scope set, stored only as a digest, and short-lived; streams are capped per
instance and bounded by `SSE_MAX_STREAM_MS`; a heartbeat keeps intermediaries
alive. Unauthorised or malformed stream requests are closed immediately, and no
QR/pairing challenge is delivered after authentication, expiry or cancellation.

## 14. Cloud API webhooks

Point Meta at `POST /api/v1/webhooks/whatsapp`.

- **Verification handshake** (`GET`): validates `hub.mode`, `hub.verify_token`
  and echoes `hub.challenge` (constant-time token compare).
- **Delivery** (`POST`): verifies the `X-Hub-Signature-256` HMAC over the raw
  request bytes (constant-time), enforces a per-IP rate limit, and de-duplicates
  by provider event id so retries are harmless.
- Message content is stored **only** when retention is explicitly enabled for
  the matching instance.

```bash
curl -s "http://localhost:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$META_VERIFY_TOKEN&hub.challenge=1234"
```

## 15. Read-only data API and retention

- For `cloud_api`, chats/messages are available **only** when the operator has
  enabled retention on the instance; otherwise the endpoints return
  `501 CAPABILITY_NOT_SUPPORTED`.
- Retention is opt-in (`RETAIN_MESSAGE_CONTENT=false` globally, and
  `retentionEnabled` per instance). Message bodies are encrypted at rest. Data
  older than the retention window is purged; an operator can purge on demand with
  an owner key:

```bash
curl -s -X POST http://localhost:3000/api/v1/instances/$INSTANCE_ID/data/purge -H "X-API-Key: $OWNER_KEY"
```

- Outbound delivery metadata is retained for `DELIVERY_METADATA_RETENTION_DAYS`
  and pruned by the same purge/retention sweep.
- Chats are **never** enumerated automatically, and message bodies never appear
  in logs. The audit trail is separate from connection metadata and exposes
  actions, never credentials, QR payloads, pairing codes or message bodies.
- **Logout vs. deletion:** an owner-initiated *disconnect without logout* keeps
  local session files for reconnection; deleting the session (`DELETE .../session`)
  removes them explicitly. The two are never conflated.

## 16. Pagination

List endpoints use **HMAC-signed opaque cursors**. Request a page with `limit`
and, for the next page, pass `nextCursor` back as `cursor`:

```bash
curl -s "http://localhost:3000/api/v1/instances/$INSTANCE_ID/chats?limit=25" -H "X-API-Key: $OWNER_KEY"
# -> { "data": { "items": [ … ] }, "pagination": { "limit": 25, "hasMore": true, "nextCursor": "…", "returned": 25 } }
```

Cursors are scoped to a resource kind and cannot be forged or reused across
kinds (`INVALID_CURSOR` on tampering).

## 17. Errors

Every error uses one shape:

```json
{
  "success": false,
  "error": { "code": "INVALID_STREAM_TOKEN", "message": "…" },
  "requestId": "req_…"
}
```

Stable codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `CAPABILITY_NOT_SUPPORTED`,
`CONNECTOR_DISABLED`, `INSTANCE_BUSY`, `INSTANCE_NOT_CONNECTED`,
`INVALID_CURSOR`, `INVALID_STREAM_TOKEN`, `INSTANCE_LIMIT_REACHED` and
`SERVICE_UNAVAILABLE`. Responses never contain stack traces or filesystem paths,
and credentials are never echoed back.

## 18. Health and observability

- `GET /health/live` — process liveness.
- `GET /health/ready` — readiness: probes the **filesystem** (`DATA_DIR`
  writable), reports the repository mode (`filesystem`), the realtime event bus,
  and the current browser-instance count. There is no database or Redis to check.
- Every request carries an `X-Request-Id` (accepted and echoed), included in logs
  and error bodies.
- Structured JSON logs (pino) with credential/QR/pairing redaction; the request
  logger is disabled under `NODE_ENV=test`.

## 19. Testing

```bash
npm test                    # unit + integration + security (hermetic, no network)
npm run test:unit
npm run test:integration
npm run test:security
```

The suite runs **without a database, Redis or a browser**: each test gets its own
temporary `DATA_DIR` and therefore exercises the real file-backed repositories,
and a fake `whatsapp-web.js` module covers the real connector code paths.
**Nothing in `npm test` talks to WhatsApp.**

Coverage includes: API-key auth, scopes, rotation and revocation; scope-escalation
prevention; corruption handling and concurrent updates (atomic writes, JSONL
read-modify-write); duplicate-browser prevention and connection-state
transitions; reconnection backoff/limits and graceful shutdown; owner-only
QR/pairing; persistence across a simulated container restart; and cross-origin,
unauthorised, invalid-key and rate-limit scenarios. Secrets are asserted absent
from logs and error bodies.

Live tests are opt-in and separate (see [`tests/live/README.md`](tests/live/README.md)):

```bash
WA_GATEWAY_LIVE_TESTS=1 npm run test:integration:live
```

Each live test skips with an explicit reason when its environment is missing, so
CI never reports a false pass.

## 20. Docker and deployment

```bash
# Lean image: official Cloud API connector only (default)
docker build -t razorbills-whatsapp .

# With the optional, authorization-gated WhatsApp Web connector
docker build --build-arg INSTALL_WEB_CONNECTOR=true -t razorbills-whatsapp:web .
```

The image is multi-stage: dependencies are installed in a builder stage and only
`node_modules` and the application code are copied into the runtime stage. The
container:

- runs as the **non-root** `node` user,
- uses `tini` as PID 1 for correct signal handling and graceful shutdown,
- stores all state in the `DATA_DIR` volume (`/app/data`, declared as a
  `VOLUME`),
- exposes **only port 3000** — there is **no remote-debugging port** (Chromium is
  launched without `--remote-debugging-port`),
- **does not disable Chromium's sandbox by default** (the explicit
  `WHATSAPP_WEB_NO_SANDBOX=true` development fallback exists for hosts that
  cannot provide user namespaces), and
- defines a `HEALTHCHECK` against `/health/live`.

The web variant additionally installs Chromium's shared libraries. Running
headless Chromium *with* its sandbox inside a container typically requires user
namespaces or, where the host disables them, an explicit capability. The image
does not weaken the sandbox; grant the required privilege to the container if the
host needs it.

`compose.yaml` brings up a **single** `gateway` service with one persistent
`gateway-data` volume mounted at `/app/data`, binds the API to loopback by
default, drops all Linux capabilities, and sets `no-new-privileges`. There is no
database and no migration step:

```bash
cp .env.example .env          # set API_KEY_PEPPER, ENCRYPTION_KEYS, and any META_* values
docker compose up -d --build
docker compose logs -f gateway
```

> **Note:** Docker was not available in the environment this project was
> developed in, so the image and compose stack have **not** been built or run
> here. The files are written to be correct and complete but should be validated
> in your CI before first production use. Likewise, the web connector's real
> browser flow (which needs `whatsapp-web.js` + `puppeteer`) is covered by an
> injected fake library rather than a real Chromium run.

## 21. Administration dashboard (ww2web)

`ww2web` is the owner's browser dashboard. It is a separate React application
living in `ww2web/` and **served by this same Express process** — there is no
second server, no second port and no second storage layer.

```
ww2web/            React + Vite source (its own package.json; JS, not TS)
  src/             pages, hooks, shadcn/ui components, generated docs copy
  dist/            Vite build output (intermediate, git-ignored)
public/frontend/   the published build the service actually serves
scripts/sync-docs.js        copy docs/ into the frontend (npm run sync:docs)
scripts/build-frontend.js   build + publish (npm run build:frontend)
```

### Build and publish

```bash
npm --prefix ww2web install     # once: frontend dependencies
npm run build:frontend          # build ww2web, then publish to public/frontend
npm start                       # open http://localhost:3000/ui/
```

`npm run build:frontend` builds the app, verifies `dist/index.html` references
the `/frontend/` asset base, stages a complete copy, and only then replaces
`public/frontend/`. The build first runs `scripts/sync-docs.js`, which copies
`docs/*.md` into the frontend so the in-app Documentation page matches the
repository. A failed build never leaves a partially-published UI. The service
itself needs **no build step**; if the dashboard has not been published it still
starts and answers `/ui/` with a clear 503 page.

### Routes

| Path | Served by |
| --- | --- |
| `GET /ui` | `308` redirect to `/ui/` |
| `GET /ui/` | `public/frontend/index.html` (the SPA shell, `Cache-Control: no-store`) |
| `GET /frontend/*` | hashed JS/CSS/font assets (`index: false`, `dotfiles: "deny"`) |

The SPA uses a **HashRouter**, so every client route lives behind `#/`
(`#/login`, `#/dashboard`, `#/connection`, `#/instances`, `#/messaging`,
`#/data`, `#/config`, `#/security`, `#/logs`, `#/settings`, `#/docs`,
`#/docs/:docId`). Only one HTML file is ever requested, so the server needs no
history fallback and cannot be tricked into serving arbitrary files. Vite's
asset base is `/frontend/` even though the app opens at `/ui/`.

### Signing in

The dashboard has no credentials of its own. The owner types an **owner API key**
(`wak_…`, holding `auth:manage` + `keys:manage`, or `*`) at `#/login`; the
service verifies it with the same `ApiKeyService` used by `X-API-Key` and
exchanges it for a short-lived server-side session:

- the key is used once and never stored in the browser;
- the session lives in an `HttpOnly`, `SameSite=Strict` (and `Secure` in
  production) cookie that page scripts cannot read;
- only an HMAC digest of the session value is kept, in memory — never on disk;
- state-changing requests carry a per-session CSRF token returned in the response
  body and held in JavaScript memory only;
- a reload re-validates the session with the server, and signing out revokes it.

A `messages:send`-only key (the RazorBills key) can never sign in. The
RazorBills `X-API-Key` is never exposed to the browser.

Owner-session tuning (see [Configuration](./docs/configuration.md)):
`OWNER_SESSION_TTL_MS`, `OWNER_SESSION_IDLE_MS`, `OWNER_SESSION_MAX`,
`OWNER_SESSION_COOKIE_SECURE`.

### What the dashboard can do

| Page | Behaviour |
| --- | --- |
| Dashboard | One snapshot: service version/environment, instance counts, readiness, browser instances, primary connection, recent events and deliveries. |
| Connection | Live connection state over SSE, QR sign-in (only when the connector supports it, with expiry countdown), pairing code (only when supported), stored-session summary, disconnect with an optional logout, and a confirmed stored-session revoke that deletes the browser profile and encrypted archive while keeping the instance. QR payloads and pairing codes are never persisted. |
| Instances | List, create (connector, name, optional `phoneNumberId`, retention), inspect fresh detail with capabilities, per-instance audit events and a confirmed data purge, and delete with confirmation. The web connector option is greyed out unless it is enabled. |
| Messaging | Recent delivery metadata (masked recipient, status, provider id) with filters, plus a single test send that must be reviewed and confirmed. No chat history, no bulk sending. |
| Data | Read-only chats and contacts for one instance, with cursor paging and a per-chat message view. Tabs are gated on the connector's real capabilities; the Cloud API exposes only retained history. |
| Configuration | Read-only effective settings. Secrets appear only as *configured / not configured*; filesystem paths are never shown. Per-instance retention is the one setting that is editable. |
| Security | API-key list, create (with scope presets), rotate, revoke and a per-key detail view. A new key is displayed **once** with a copy warning; existing plaintext keys can never be retrieved. |
| Logs | Paginated, filterable audit trail (category, result, instance, action, date range) with a detail view. Logs never contain QR payloads, pairing codes, API keys or message bodies. |
| Settings | Theme, live-refresh cadence, owner-session summary, dashboard/service versions and readiness diagnostics. |
| Documentation | Every `docs/*.md` document, grouped and searchable, rendered with GFM, heading anchors and rewritten relative links. The copy is generated at build time. |

### Dashboard API

The dashboard reuses the normal `/api/v1/*` routes (cookie auth is accepted
alongside `X-API-Key`). Eight owner-only endpoints exist under `/api/v1/ui` for
views that no single existing route provides:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/ui/auth/login` | Exchange an owner key for a session cookie (rate-limited). |
| `GET /api/v1/ui/auth/session` | Confirm the session and return a fresh CSRF token. |
| `POST /api/v1/ui/auth/logout` | Revoke the session (cookie + CSRF only). |
| `GET /api/v1/ui/overview` | Aggregated dashboard snapshot. |
| `GET /api/v1/ui/config` | Redacted effective configuration. |
| `GET /api/v1/ui/connectors` | Connector capability descriptors. |
| `GET /api/v1/ui/deliveries` | Delivery metadata for the Messaging page. |
| `GET /api/v1/ui/audit-events` | Filtered, paginated audit events. |

All of them require an owner session (or an owner key) and never return secrets.

## 22. Backup, restore, permissions and secure deletion

- **Permissions.** Create `DATA_DIR` with `0700`, owned by the `node` user the
  container runs as. Subdirectories and files are created `0700`/`0600`
  automatically. Never make `DATA_DIR` world-readable.
- **Backup.** Back up the whole `DATA_DIR` (keys, instances, sessions,
  deliveries, audit). It is sensitive: API keys are stored only as digests, but
  session archives and message bodies are protected by your `ENCRYPTION_KEYS`
  keyring, so **back up the keyring separately** (in your secret manager) — a
  backup without the keyring cannot be restored.
- **Restore.** Stop the service, restore the directory to the same path, then
  start. Previously-live `cloud_api` instances reconnect automatically; web
  instances require the owner to re-scan a QR code.
- **Never** place `DATA_DIR` inside the image, a download directory, a static
  directory, or version control. The web connector's `local` browser profile is
  **not** encrypted by this service: store `DATA_DIR` on an encrypted volume or a
  disk with whole-disk encryption.
- **Secure deletion.** Deleting an instance removes its directory. To purge
  retained message content on demand, use `POST .../data/purge` (message bodies
  are encrypted, but the ciphertext files are removed as well). Deleting the
  session (`DELETE .../session`) removes the local browser profile and/or
  encrypted archive. Use `shred`/`srm` or an encrypted volume if you need to
  guarantee that plaintext blocks cannot be recovered after deletion.
- **Encryption keys** come only from the environment or a secret manager. Never
  commit them. Rotate by adding a new key id to the ring (keep the old key until
  old ciphertext is re-written) and update `ENCRYPTION_KEY_ID`.
- **In-memory state.** Rate-limit counters and single-use stream tokens live only
  in the process and reset on restart. That is expected for a single-process
  deployment.

## 23. Operations and production checklist

- [ ] `NODE_ENV=production`; `DATA_DIR` points at a persistent, `0700` volume on
      encrypted storage.
- [ ] `API_KEY_PEPPER` (≥ 32 chars) and the AES-256-GCM keyring are injected from
      a secret manager — never from a committed file. Back the keyring up
      separately.
- [ ] `CORS_ORIGINS` is a specific allowlist (not `*`); `IP_ALLOWLIST` restricts
      the API to the backend's egress where possible.
- [ ] A single service process runs against each `DATA_DIR` (no multiple
      replicas).
- [ ] The API sits behind a TLS-terminating proxy; bind to loopback where
      possible. No debugging ports exposed.
- [ ] Cloud API credentials (`META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`,
      `META_VERIFY_TOKEN`, `META_APP_SECRET`) are set and the webhook is
      subscribed to `messages`.
- [ ] The owner key holds `auth:manage`/`keys:manage`; the RazorBills key holds
      `messages:send` only. Keys are stored in a secret manager and rotated on a
      schedule.
- [ ] Retention is a deliberate choice per instance; audit and delivery-metadata
      retention are set.
- [ ] The web connector, if enabled at all, has a recorded
      `WHATSAPP_WEB_AUTHORIZATION_REFERENCE`, a private session directory, and
      `WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted` for encryption at rest.
- [ ] The dashboard is published (`npm run build:frontend`) and reachable over
      HTTPS only, so the owner-session cookie is sent `Secure`; `/ui/` is behind
      the same TLS-terminating proxy as the API.

## 24. License

MIT — see [LICENSE](LICENSE).
