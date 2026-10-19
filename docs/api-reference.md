# API reference

Base path: `/api/v1`. Unless stated otherwise every route requires an
`X-API-Key` header carrying a key with the listed scope.

- `:instanceId` matches `^ins_[a-f0-9]{32}$`.
- `:chatId` matches `^[A-Za-z0-9@._-]{5,80}$`.
- `:keyId` matches `^[a-f0-9]{18}$`.
- `:ruleId` matches `^arr_[a-f0-9]{24}$`.

## Response envelope

**Success**

```json
{ "success": true, "data": { ... } }
```

List responses add a `pagination` object:

```json
{
  "success": true,
  "data": { "items": [ ... ], "limitations": [ ... ] },
  "pagination": { "limit": 25, "returned": 25, "hasMore": true, "nextCursor": "..." }
}
```

**Error**

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { ... } },
  "requestId": "req_..."
}
```

`details` is present only for operational errors — 4xx errors, and curated
connector/capability errors (5xx) whose messages are authored to be safe. See
[Errors](./errors.md) for the full code list.

**Headers**

- `X-Request-Id` — accepted from the client (`^[\w.:-]{1,128}$`) or generated,
  echoed on every response, and included in error bodies.
- `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`.

## Endpoint index

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/health/live` | _none_ |
| `GET` | `/health/ready` | _none_ |
| `GET` | `/api/v1/webhooks/whatsapp` | _Meta handshake_ |
| `POST` | `/api/v1/webhooks/whatsapp` | _Meta signature_ |
| `GET` | `/api/v1/connectors` | `instances:read` |
| `POST` | `/api/v1/instances` | `auth:manage` |
| `GET` | `/api/v1/instances` | `instances:read` |
| `GET` | `/api/v1/instances/:instanceId` | `instances:read` |
| `GET` | `/api/v1/instances/:instanceId/status` | `connection:read` |
| `GET` | `/api/v1/instances/:instanceId/capabilities` | `instances:read` |
| `POST` | `/api/v1/instances/:instanceId/connect/qr` | `auth:manage` |
| `POST` | `/api/v1/instances/:instanceId/connect/pairing-code` | `auth:manage` |
| `POST` | `/api/v1/instances/:instanceId/disconnect` | `auth:manage` |
| `GET` | `/api/v1/instances/:instanceId/session` | `instances:read` |
| `DELETE` | `/api/v1/instances/:instanceId/session` | `auth:manage` |
| `GET` | `/api/v1/instances/:instanceId/retention` | `instances:read` |
| `PUT` | `/api/v1/instances/:instanceId/retention` | `auth:manage` |
| `POST` | `/api/v1/instances/:instanceId/data/purge` | `auth:manage` |
| `GET` | `/api/v1/instances/:instanceId/audit-events` | `audit:read` |
| `DELETE` | `/api/v1/instances/:instanceId` | `auth:manage` |
| `GET` | `/api/v1/instances/:instanceId/chats` | `data:read` |
| `GET` | `/api/v1/instances/:instanceId/chats/:chatId` | `data:read` |
| `GET` | `/api/v1/instances/:instanceId/chats/:chatId/messages` | `data:read` |
| `GET` | `/api/v1/instances/:instanceId/messages` | `data:read` |
| `GET` | `/api/v1/instances/:instanceId/messages/:messageId` | `data:read` |
| `GET` | `/api/v1/instances/:instanceId/contacts` | `data:read` |
| `GET` | `/api/v1/instances/:instanceId/autoreplies` | `data:read` |
| `POST` | `/api/v1/instances/:instanceId/autoreplies` | `auth:manage` |
| `GET` | `/api/v1/instances/:instanceId/autoreplies/:ruleId` | `data:read` |
| `PATCH` | `/api/v1/instances/:instanceId/autoreplies/:ruleId` | `auth:manage` |
| `DELETE` | `/api/v1/instances/:instanceId/autoreplies/:ruleId` | `auth:manage` |
| `POST` | `/api/v1/instances/:instanceId/auth/stream-token` | `connection:read` |
| `GET` | `/api/v1/instances/:instanceId/auth/events` | `connection:read` (header or `?streamToken=`) |
| `POST` | `/api/v1/messages/send` | `messages:send` |
| `POST` | `/api/v1/api-keys` | `keys:manage` |
| `GET` | `/api/v1/api-keys` | `keys:manage` |
| `GET` | `/api/v1/api-keys/:keyId` | `keys:manage` |
| `POST` | `/api/v1/api-keys/:keyId/rotate` | `keys:manage` |
| `DELETE` | `/api/v1/api-keys/:keyId` | `keys:manage` |
| `POST` | `/api/v1/ui/auth/login` | _owner key_ |
| `GET` | `/api/v1/ui/auth/session` | _owner session cookie_ |
| `POST` | `/api/v1/ui/auth/logout` | _owner session cookie + CSRF_ |
| `GET` | `/api/v1/ui/overview` | `auth:manage` + `keys:manage` |
| `GET` | `/api/v1/ui/config` | `auth:manage` + `keys:manage` |
| `GET` | `/api/v1/ui/connectors` | `auth:manage` + `keys:manage` |
| `GET` | `/api/v1/ui/deliveries` | `auth:manage` + `keys:manage` |
| `GET` | `/api/v1/ui/audit-events` | `auth:manage` + `keys:manage` |

Routes marked _owner session cookie_ accept the `ww2_owner_session` cookie
instead of `X-API-Key` (and are also reachable with an owner key). See
[Owner dashboard](./admin-dashboard.md) and
[Authentication](./authentication.md#owner-dashboard-sessions).

---

## Health

### `GET /health/live`

Process liveness. No credential. Exposes no sensitive data.

```json
{ "success": true, "data": { "status": "ok", "service": "razorbills-whatsapp", "uptimeSeconds": 42 } }
```

### `GET /health/ready`

Readiness. Probes the filesystem (`DATA_DIR` writable). Returns `503` with
`data.status = "unavailable"` when storage is not writable.

```json
{
  "success": true,
  "data": {
    "status": "ready",
    "checks": {
      "storage": { "ok": true, "mode": "filesystem" },
      "realtime": { "ok": true, "mode": "in-process" },
      "browserInstances": 0
    }
  }
}
```

---

## Connectors

### `GET /connectors` — scope `instances:read`

Returns the default connector and each connector's capability descriptor
(produced by the connector classes themselves).

```json
{
  "success": true,
  "data": {
    "default": "cloud_api",
    "connectors": {
      "cloud_api": { "connector": "cloud_api", "official": true, "...": "..." },
      "web": { "connector": "web", "official": false, "enabled": false, "...": "..." }
    },
    "notes": [ "..." ]
  }
}
```

Each descriptor includes a `supportedEndpoints` map and a `limitations` array.

---

## Instances

### `POST /instances` — scope `auth:manage`

Create an instance. Returns `201`.

Body:

```json
{
  "connector": "cloud_api",
  "displayName": "Acme support",
  "retentionEnabled": true,
  "retentionDays": 7,
  "metadata": { "phoneNumberId": "1234567890", "label": "support", "authorizationReference": null }
}
```

- `connector` optional; defaults to `DEFAULT_CONNECTOR`.
- `displayName` optional, 1–80 printable characters.
- `retentionDays` optional, 0–3650; must be > 0 when retention is enabled.
- `metadata` is a strict object; only `phoneNumberId`, `label` and
  `authorizationReference` are kept.

Response:

```json
{
  "success": true,
  "data": {
    "instance": {
      "id": "ins_...",
      "tenantId": "default",
      "connector": "cloud_api",
      "displayName": "Acme support",
      "status": "created",
      "metadata": {},
      "retention": { "enabled": true, "days": 7 },
      "createdAt": "...",
      "updatedAt": "...",
      "lastConnectedAt": null
    },
    "capabilities": { "...": "..." }
  }
}
```

### `GET /instances` — scope `instances:read`

Paginated list, newest first. `limit` (default 25, max page size 100) and
`cursor` query params. A key's `allowedInstanceIds` filters the visible items.

### `GET /instances/:instanceId` — scope `instances:read`

```json
{ "success": true, "data": { "instance": { "...": "..." }, "capabilities": { "...": "..." } } }
```

Returns `404` across tenant/allowlist boundaries.

### `GET /instances/:instanceId/status` — scope `connection:read`

The live status, combining the persisted connection state and the connector's
own status.

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "connector": "cloud_api",
    "connectionState": "CONNECTED",
    "attempt": 0,
    "nextAttemptAt": null,
    "lastError": null,
    "capabilities": { "...": "..." },
    "status": "ready",
    "live": true,
    "details": { "displayPhoneNumber": "+1 555 ...", "verifiedName": "Acme" },
    "qr": null
  }
}
```

`live` is `false` and `details` is empty when no connector is currently running
for the instance.

For the **web** connector, `details` additionally carries:
- `qrExpiresAt` / `pairingExpiresAt` — expiry of the current challenge, if any;
- `authState` — the library's own connection state (`OPENING`, `PAIRING`, …);
- `loading` — post-authentication chat sync progress (`percent`, `message`,
  `complete`) or `null`;
- the top-level `qr` field carries the current challenge (`qrDataUrl`,
  `expiresAt`, `attempt`) or `null`.

`authState` and `loading` are display-only; the persisted connection state is
unchanged by them.

### `GET /instances/:instanceId/capabilities` — scope `instances:read`

```json
{ "success": true, "data": { "instanceId": "ins_...", "connector": "web", "capabilities": { "...": "..." } } }
```

### `POST /instances/:instanceId/connect/qr` — scope `auth:manage`

Begin QR authentication (web connector) or credential verification (cloud_api;
no QR).

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "connector": "web",
    "status": "awaiting_qr",
    "qr": { "qrDataUrl": "data:image/png;base64,...", "expiresAt": "...", "attempt": 1 },
    "qrExpiresAt": "...",
    "eventsEndpoint": "/api/v1/instances/ins_.../auth/events",
    "capabilities": { "...": "..." },
    "note": "QR payloads are short-lived authentication credentials. ..."
  }
}
```

- Loading an already-active session returns the current status instead of
  launching a second browser.
- Concurrent initialisations are serialised by the per-instance lock
  (`409 INSTANCE_BUSY` if one is already running with no wait).
- `502 CONNECTOR_ERROR` if credential verification fails.

### `POST /instances/:instanceId/connect/pairing-code` — scope `auth:manage`

Request a WhatsApp Web device-linking code. Not an SMS code.

Body:

```json
{ "phoneNumber": "919812345678", "force": false }
```

- `phoneNumber`: international format, digits only, `^[1-9]\d{7,19}$`.
- `force`: request a fresh code even if one is pending (otherwise a still-valid
  code is reused; forcing while one is pending is `409 CONFLICT`).

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "connector": "web",
    "status": "awaiting_pairing_code",
    "pairingCode": "ABCD1234",
    "expiresAt": "...",
    "reused": false,
    "capabilities": { "...": "..." },
    "note": "This is a WhatsApp Web device-linking code ..."
  }
}
```

Not supported by `cloud_api` → `501 CAPABILITY_NOT_SUPPORTED`.

### `POST /instances/:instanceId/disconnect` — scope `auth:manage`

Stop the connector. Optional body `{ "logout": true|false }`.

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "status": "disconnected",
    "sessionRevoked": false,
    "note": "The stored session was kept so the instance can reconnect."
  }
}
```

- `logout: false` (default) keeps local session material for reconnection.
- `logout: true` also removes the stored session material.

### `GET /instances/:instanceId/session` — scope `instances:read`

Non-sensitive session metadata. Never returns ciphertext or profile contents.

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "session": {
      "encryptedArchive": { "present": true, "keyId": "k1", "strategy": "remote_encrypted", "updatedAt": "..." },
      "browserProfileDirectory": true,
      "atRestEncryption": "encrypted (AES-256-GCM) for the session archive; ..."
    }
  }
}
```

### `DELETE /instances/:instanceId/session` — scope `auth:manage`

Remove every trace of the instance's authentication material (browser profile
directory and/or encrypted archive) **without** deleting the instance.

```json
{ "success": true, "data": { "instanceId": "ins_...", "sessionRevoked": true, "directoryRemoved": true, "archiveRemoved": true } }
```

### `GET /instances/:instanceId/retention` — scope `instances:read`

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "retention": {
      "retainMessageContent": true,
      "retentionDays": 7,
      "globalDefault": { "retainMessageContent": false, "retentionDays": 7, "maxRetentionDays": 365 },
      "storedMessages": 12,
      "auditEventsRetentionDays": 90
    }
  }
}
```

### `PUT /instances/:instanceId/retention` — scope `auth:manage`

Body: `{ "retentionEnabled": bool, "retentionDays": int }` (both optional).
Returns the updated retention descriptor.

### `POST /instances/:instanceId/data/purge` — scope `auth:manage`

Immediately delete stored rows for the instance (retained messages, webhook
de-duplication markers, delivery metadata).

```json
{ "success": true, "data": { "instanceId": "ins_...", "messagesDeleted": 12, "webhookEventsDeleted": 30, "deliveriesDeleted": 4 } }
```

### `GET /instances/:instanceId/audit-events` — scope `audit:read`

Query: `limit` (max 200, default 50), `action` (optional filter).

```json
{ "success": true, "data": { "items": [ { "id": "evt_...", "action": "instance.created", "result": "success", "...": "..." } ] } }
```

Audit events never contain credentials, QR payloads, pairing codes or message
bodies.

### `DELETE /instances/:instanceId` — scope `auth:manage`

Full teardown: stop the connector, purge retained data, destroy session
material, delete the connection state and the instance record.

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "deleted": true,
    "purged": { "messages": 12, "webhookEvents": 30, "sessionDirectory": true, "sessionArchive": true }
  }
}
```

---

## Data (read-only) — scope `data:read`

Every response includes a `limitations` array stating what the selected
connector genuinely cannot provide. A connector that cannot serve an endpoint
returns `501 CAPABILITY_NOT_SUPPORTED`.

### `GET /instances/:instanceId/chats`

Query: `limit`, `cursor`, `since`, `until` (ISO-8601, window ≤ 366 days).

```json
{ "success": true, "data": { "items": [ { "chatId": "...", "displayName": "...", "lastMessageAt": "..." } ], "limitations": [ ... ] }, "pagination": { ... } }
```

### `GET /instances/:instanceId/chats/:chatId`

Returns the chat, or `404 NOT_FOUND` when the id is not a chat the connector can
serve.

### `GET /instances/:instanceId/chats/:chatId/messages`

Query: `limit`, `cursor`, `since`, `until`, `direction` (`inbound|outbound`).

### `GET /instances/:instanceId/messages`

Instance-wide recorded history (incoming **and** outgoing), newest first. This
is the REST counterpart of the live `message.received` / `message.sent` events.

Query: `limit`, `cursor`, `since`, `until`, `direction` (`inbound|outbound`),
`chatId`.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "wamid...",
        "storedId": "msg_...",
        "chatId": "919812345678",
        "direction": "outbound",
        "type": "text",
        "body": "Hi, how are you",
        "contentRetained": true,
        "from": null,
        "to": "919812345678",
        "timestamp": "...",
        "source": "retained_outbound_messages"
      }
    ],
    "limitations": [ ... ]
  },
  "pagination": { ... }
}
```

- When retention is enabled the items come from the retention store and
  `contentRetained` reports whether a body was written.
- When retention is off, the WhatsApp Web connector serves a bounded in-memory
  buffer of messages seen since the session started (`contentRetained: false`
  for messages whose body is not persisted); the Cloud API serves an empty list
  with a limitation.
- `body` is `null` when content was not retained.

### `GET /instances/:instanceId/messages/:messageId`

One recorded message. `:messageId` accepts either the stored id (`msg_…`) or the
provider message id. `404 NOT_FOUND` when the connector never recorded it.

### `GET /instances/:instanceId/contacts`

Query: `limit`, `cursor`. Not supported by `cloud_api` → `501`.

---

## Automatic replies

Per-instance rules that reply to matching **incoming** direct messages. Rules
are configuration (a literal match and a reply body); they contain no
credentials, and the reply is only ever sent, never stored. Reads require
`data:read`; changes are owner-only (`auth:manage`).

A rule:

```json
{
  "id": "arr_...",
  "name": "Greeting",
  "enabled": true,
  "match": { "type": "exact", "value": "/hi", "caseSensitive": false },
  "reply": { "text": "Hi, how are you" },
  "cooldownSeconds": 0,
  "createdAt": "...",
  "updatedAt": "...",
  "stats": { "matches": 0, "replies": 0, "failures": 0, "lastMatchedAt": null, "lastError": null }
}
```

- `match.type` is one of `exact`, `contains`, `prefix`, `regex`.
- `match.value` is 1–500 characters; a `regex` value must compile.
- `reply.text` is 1–4096 characters.
- `cooldownSeconds` (0–86400) limits how often a rule replies in the same chat.
- At most 50 rules per instance.

### `GET /instances/:instanceId/autoreplies`

```json
{ "success": true, "data": { "items": [ { "...": "..." } ], "limitations": [ ... ] } }
```

### `POST /instances/:instanceId/autoreplies`

Body: `{ name?, enabled?, match, reply, cooldownSeconds? }`. Returns `201` with
`{ "rule": { ... } }`.

### `GET /instances/:instanceId/autoreplies/:ruleId`

Returns `{ "rule": { ... } }`, or `404`.

### `PATCH /instances/:instanceId/autoreplies/:ruleId`

Body: any subset of `name`, `enabled`, `match`, `reply`, `cooldownSeconds`.

### `DELETE /instances/:instanceId/autoreplies/:ruleId`

```json
{ "success": true, "data": { "ruleId": "arr_...", "deleted": true } }
```

Behaviour:

- Only **incoming** messages are matched, so a reply can never trigger another
  reply.
- The first matching **enabled** rule wins; rules are evaluated in creation
  order.
- Direct chats only — group, broadcast and newsletter chats are never
  auto-replied.
- The reply is addressed to the **exact inbound chat id**, including LID-based
  (`...@lid`) ids, so it reaches the same conversation rather than a guessed
  phone-number id.
- The reply is sent through the instance's own connector, so it requires the
  instance to be connected; a failed send is recorded in `stats.failures` and
  audited, and is never retried blindly.
- `autoreply.created`, `autoreply.updated`, `autoreply.deleted` and
  `autoreply.sent` are written to the audit log (no bodies).

---

## Outbound — scope `messages:send`

### `POST /messages/send`

Body:

```json
{
  "instanceId": "ins_...",
  "to": "15551234567",
  "type": "text",
  "text": "Your invoice is ready",
  "idempotencyKey": "order-42"
}
```

- `to`: either a phone number in international format (a leading `+` is trimmed; digits only, `^[1-9]\d{6,19}$`) or a full WhatsApp chat id such as `131355503402@c.us` or `33247392198739@lid`.
- `type` must be `text` when present.
- `text`: 1–4096 characters.
- `idempotencyKey` optional; may instead be supplied via the `Idempotency-Key`
  header (header wins).

Response:

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "to": "15551234567",
    "status": "accepted",
    "providerMessageId": "wamid...",
    "acceptedAt": "...",
    "idempotent": false,
    "connector": "cloud_api",
    "note": "Meta accepted the send request. Delivery to the handset is not confirmed."
  }
}
```

See [Outbound messaging](./outbound-messaging.md) for statuses, idempotency and
limits.

---

## Real-time authentication events

### `POST /instances/:instanceId/auth/stream-token` — scope `connection:read`

Exchange the API key for a single-use stream token.

```json
{
  "success": true,
  "data": {
    "token": "...",
    "expiresAt": "...",
    "expiresInMs": 60000,
    "eventsEndpoint": "/api/v1/instances/ins_.../auth/events",
    "singleUse": true,
    "note": "The token is single-use, bound to this instance, and expires shortly."
  }
}
```

### `GET /instances/:instanceId/auth/events`

Server-Sent Events. Authenticate with the `X-API-Key` header **or** a
single-use `?streamToken=` query parameter. See
[Real-time events](./realtime-events.md).

---

## API keys — scope `keys:manage`

### `POST /api-keys`

Create a key. Returns `201`. See
[Authentication → Key lifecycle](./authentication.md#key-lifecycle).

### `GET /api-keys`

Query: `limit` (max 200), `offset`.

```json
{ "success": true, "data": { "items": [ { "keyId": "...", "scopes": [ ... ] } ], "availableScopes": [ ... ] } }
```

### `GET /api-keys/:keyId`

Public view of one key. `404` if it belongs to another tenant.

### `POST /api-keys/:keyId/rotate`

Body: `{ "gracePeriodMs": 300000 }` (optional, 0–86400000). Returns the new
plaintext key and revokes the old one.

### `DELETE /api-keys/:keyId`

```json
{ "success": true, "data": { "keyId": "...", "revokedAt": "...", "alreadyRevoked": false } }
```

---

## Webhooks

### `GET /api/v1/webhooks/whatsapp`

Meta verification handshake. Query: `hub.mode=subscribe`, `hub.verify_token`,
`hub.challenge`. Echoes the challenge as `text/plain` on success, `403
Forbidden` otherwise. No API key.

### `POST /api/v1/webhooks/whatsapp`

Meta message/status delivery. Protected by `X-Hub-Signature-256` (HMAC over the
raw body), not an API key.

```json
{ "success": true, "data": { "accepted": true, "messages": 1, "statuses": 0, "duplicates": 0, "unmatched": 0 } }
```

See [Cloud API webhooks](./webhooks.md).

---

## Owner dashboard

These endpoints exist for the `ww2web` dashboard. They return the same envelope
as the rest of the API and never contain secrets. See
[Owner dashboard](./admin-dashboard.md) for the pages that consume them.

### `POST /api/v1/ui/auth/login`

Exchange an owner API key for a session. Rate-limited by the `auth` bucket.

Body: `{ "apiKey": "wak_…" }` — a key holding **both** `auth:manage` and
`keys:manage` (or `*`). A `messages:send` key is refused.

```json
{
  "success": true,
  "data": {
    "csrfToken": "…",
    "expiresAt": "…",
    "owner": { "keyId": "…", "name": "…", "tenantId": "…", "scopes": [ ... ] }
  }
}
```

Response headers include
`Set-Cookie: ww2_owner_session=<opaque>; HttpOnly; SameSite=Strict; Path=/; [Secure]`.
The cookie value is opaque and is never returned in a body.

### `GET /api/v1/ui/auth/session`

Confirms the session and returns a fresh `csrfToken` plus the owner view. `401`
when there is no valid session, in which case any stale cookie is cleared.

### `POST /api/v1/ui/auth/logout`

Revokes the current session and clears the cookie. Requires the session cookie
**and** the `X-CSRF-Token` header. Idempotent.

### `GET /api/v1/ui/overview`

One aggregated snapshot — the dashboard's primary read:

```json
{
  "success": true,
  "data": {
    "service": { "name": "...", "version": "1.0.0", "environment": "production", "uptimeSeconds": 42, "serverTime": "..." },
    "connections": { "total": 2, "byStatus": { "ready": 1, "created": 1 }, "items": [ ... ] },
    "browsers": { "running": 1, "max": 3, "snapshot": [] },
    "primary": { "instanceId": "ins_…", "connector": "web", "status": "ready", "connectionState": "CONNECTED", "live": true, "lastError": null, "attempt": 0, "nextAttemptAt": null, "details": { ... }, "qrAvailable": false },
    "recentEvents": [ ... ],
    "recentDeliveries": [ ... ],
    "features": { "cloudConfigured": true, "webConnectorEnabled": false, "outboundMessagingEnabled": true, "qrAuth": false, "pairingCode": false }
  }
}
```

`qrAvailable` is a boolean only — a QR payload is never included in the overview.

### `GET /api/v1/ui/config`

Redacted effective configuration: service identity, connector credential
**statuses**, security posture, reconnection, rate limits, messaging, events,
limits, pagination, storage mode and shutdown timeout. Secret values and the
resolved `DATA_DIR` path are never returned; secret-bearing settings appear as
`"configured"` / `"not configured"`.

### `GET /api/v1/ui/connectors`

```json
{
  "success": true,
  "data": {
    "default": "cloud_api",
    "connectors": {
      "cloud_api": { "official": true, "enabled": true, "qrAuth": false, "pairingCode": false, "outboundMessaging": false, "limitations": [ ... ] },
      "web": { "official": false, "enabled": false, "qrAuth": false, "pairingCode": false, "limitations": [ ... ] }
    }
  }
}
```

Capabilities come from the connector classes themselves. A disabled connector is
reported as `enabled: false` with the reason — the request never fails because
the operator switched a connector off.

### `GET /api/v1/ui/deliveries`

Query: `instanceId` (optional, must be owned), `limit` (max 200).

Delivery metadata, newest first across the owner's visible instances when no
`instanceId` is given:

```json
{ "success": true, "data": { "items": [ { "id": "...", "instanceId": "ins_…", "status": "accepted", "createdAt": "...", "providerMessageId": "wamid.…", "errorCode": null, "recipientMasked": "••••1234" } ] } }
```

The recipient is masked and message bodies are never included.

### `GET /api/v1/ui/audit-events`

Query: `limit` (max 200), `offset`, `action` (exact), `category`
(`authentication` \| `security` \| `connection` \| `configuration` \|
`messaging`), `result` (`success` \| `failure`), `instanceId`, `since`, `until`
(ISO-8601 datetimes).

```json
{
  "success": true,
  "data": { "items": [ { "id": "...", "action": "instance.created", "result": "success", "instanceId": "ins_…", "actorKeyId": "…", "requestId": "req_…", "ip": "…", "createdAt": "…", "metadata": { ... } } ] },
  "pagination": { "limit": 25, "offset": 0, "returned": 25, "hasMore": true, "nextOffset": 25, "scanned": 250 }
}
```

Filtering is applied over a bounded scan of the most recent events
(`MAX_AUDIT_SCAN = 1000`); `pagination.scanned` reports how many events were
examined, so a "no results" answer is always explainable.

## Dashboard static hosting

Not part of `/api/v1` (no API key), served by the same process:

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/ui` | `308` redirect to `/ui/` |
| `GET` | `/ui/` | the SPA shell (`public/frontend/index.html`), or a `503` page when it has not been built |
| `GET` | `/frontend/*` | hashed build assets; `404` JSON for anything missing |

---

## Pagination

List endpoints use HMAC-signed opaque cursors. Request a page with `limit` and
pass the returned `nextCursor` back as `cursor`. Cursors are scoped to a resource
kind and cannot be forged or reused across kinds (`INVALID_CURSOR` on tampering).

```json
"pagination": { "limit": 25, "returned": 25, "hasMore": true, "nextCursor": "..." }
```

## Related

- [Authentication](./authentication.md)
- [Owner dashboard](./admin-dashboard.md)
- [Errors](./errors.md)
- [Outbound messaging](./outbound-messaging.md)
- [Real-time events](./realtime-events.md)
