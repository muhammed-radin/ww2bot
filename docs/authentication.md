# Authentication

## How authentication works

Every `/api/v1` route except the Meta webhook receiver requires an API key in the
**`X-API-Key` header**. A key is **never** accepted in a query string or path, so
it cannot end up in access logs, proxies, referrers or browser history.

1. `authenticate` (middleware) reads the header and verifies the key.
2. On success it attaches `req.auth = { keyId, tenantId, scopes, allowedInstanceIds, name }`.
3. `requireScopes(...)` enforces the scopes a route needs.
4. `loadInstance` enforces tenant isolation and the key's instance allowlist.

The only exception is the SSE event stream, which may instead accept a tooltip
single-use **stream token** (see [Real-time events](./realtime-events.md)) because
browser `EventSource` cannot send headers. A long-lived API key is never accepted
in a URL.

`authenticate` accepts a second credential: the **owner dashboard session
cookie**. It is checked first, and is created by exchanging an owner API key for
a server-side session (see [Owner dashboard sessions](#owner-dashboard-sessions)).
Requests authenticated that way must also present a CSRF token on state-changing
methods; API-key requests never need one.

## Key format

```
wak_<keyId>_<secret>
```

- `keyId` = 18 lowercase hex characters (72 bits) — non-secret, used for lookup.
- `secret` = 32 random bytes, base64url (43 chars) — the actual credential.
- Full key entropy: 256 bits from the CSPRNG.

### Storage

- Only an **HMAC-SHA256 digest keyed with `API_KEY_PEPPER`** is stored
  (`keyHash` in `data/api-keys/keys.json`).
- The plaintext key is returned **exactly once**, in the `201`/`200` response at
  creation/rotation. It is never persisted or logged.
- Verification uses a **constant-time comparison**, so responses do not reveal
  which part of a key was wrong.
- Failure reasons (`hash_mismatch`, `revoked`, `expired`) are recorded in the
  audit trail, but only the generic `UNAUTHORIZED` message is returned.

## Scopes

| Scope | Grants | Intended holder |
| --- | --- | --- |
| `messages:send` | Send outbound messages | **RazorBills backend** |
| `instances:read` | Read instances, capabilities, session metadata, retention | RazorBills backend (optional) |
| `connection:read` | Read live status, issue stream tokens, open event streams | RazorBills backend (optional) |
| `data:read` | Read chats, messages, contacts | owner |
| `audit:read` | Read the audit trail | owner |
| `auth:manage` | Initialise/disconnect, QR/pairing, revoke session, purge data, delete instance | **owner only** |
| `keys:manage` | Create/list/rotate/revoke API keys | **owner only** |
| `*` | Every scope | **owner only** |

`OWNER_SCOPES = [auth:manage, keys:manage]`. The wildcard `*` cannot be combined
with other scopes.

## Route → scope map

| Route | Scope |
| --- | --- |
| `GET /connectors` | `instances:read` |
| `GET /instances`, `GET /instances/:id`, `GET /instances/:id/capabilities` | `instances:read` |
| `GET /instances/:id/session`, `GET /instances/:id/retention` | `instances:read` |
| `GET /instances/:id/status` | `connection:read` |
| `POST /instances/:id/auth/stream-token`, `GET /instances/:id/auth/events` | `connection:read` |
| `POST /instances` | `auth:manage` |
| `POST /instances/:id/connect/qr`, `.../connect/pairing-code` | `auth:manage` |
| `POST /instances/:id/disconnect` | `auth:manage` |
| `DELETE /instances/:id/session` | `auth:manage` |
| `PUT /instances/:id/retention` | `auth:manage` |
| `POST /instances/:id/data/purge` | `auth:manage` |
| `DELETE /instances/:id` | `auth:manage` |
| `GET /instances/:id/chats`, `.../chats/:chatId`, `.../chats/:chatId/messages`, `.../contacts` | `data:read` |
| `GET /instances/:id/audit-events` | `audit:read` |
| `POST /messages/send` | `messages:send` |
| `POST/GET/… /api-keys*` | `keys:manage` |

A request with a valid key but a missing scope is `403 FORBIDDEN` with a
`missingScopes` detail.

## Tenant isolation and instance allowlists

- Every resource belongs to exactly one internal tenant (`DEFAULT_TENANT_ID`).
- Reading another tenant's resource returns **404, never 403**, so a key holder
  cannot probe for the existence of foreign resources.
- A key may additionally be restricted to an **allowlist of instance ids**. If
  set, addressing any other instance (even within the tenant) also returns 404.

```json
{ "name": "razorbills", "scopes": ["messages:send"], "allowedInstanceIds": ["ins_ab12...cd34"] }
```

## Privilege-escalation guards

A key can never gain more than the actor that creates or rotates it holds:

- A **non-wildcard** actor cannot grant a scope it does not hold
  → `403 FORBIDDEN` (`escalatedScopes`).
- Only a **wildcard** (`*`) actor may mint another wildcard key.
- There is **no unrestricted key-creation endpoint**: creating any key requires
  `keys:manage`, which is owner-only.
- A key can only manage keys **inside its own tenant**; creating a key for a
  different `tenantId` is refused.

## Key lifecycle

### Create

```
POST /api/v1/api-keys          # scope: keys:manage
```

Body:

```json
{
  "name": "razorbills",
  "scopes": ["messages:send"],
  "tenantId": "default",
  "allowedInstanceIds": ["ins_ab12...cd34"],
  "expiresAt": "2027-01-01T00:00:00Z",
  "ttlDays": 90
}
```

- `scopes` is required and must be non-empty.
- `allowedInstanceIds` is optional; `null` means "all tenant instances". An empty
  array is rejected (use `null`).
- `expiresAt` (ISO-8601) and `ttlDays` are optional; `ttlDays` must be 1–3650.

Response `201`:

```json
{
  "success": true,
  "data": {
    "apiKey": "wak_...",
    "warning": "Store this key securely now. It cannot be retrieved again.",
    "key": { "id": "...", "keyId": "...", "scopes": ["messages:send"], "...": "..." }
  }
}
```

### List / read

```
GET /api/v1/api-keys?limit=50&offset=0
GET /api/v1/api-keys/:keyId
```

Listing returns public views only — the digest is never exposed — plus the
`availableScopes` list.

### Rotate

```
POST /api/v1/api-keys/:keyId/rotate
```

Issues a new secret with identical scopes/tenant/allowlist and revokes the old
one. `gracePeriodMs` (optional) keeps the previous key valid for that many
milliseconds, useful for zero-downtime rollouts; default `0` = immediate.

### Revoke

```
DELETE /api/v1/api-keys/:keyId
```

Revocation is immediate (or at the grace-period timestamp set by a prior rotate).
Revoking an already-revoked key is idempotent (`alreadyRevoked: true`).

## Owner-only controls

`auth:manage` and `keys:manage` are reserved for the owner. The RazorBills
backend key should be created with only `messages:send` (optionally
`instances:read` / `connection:read`). This means the integration key cannot:

- create or delete instances,
- initialise WhatsApp, view a QR code or request a pairing code,
- disconnect or revoke a session,
- purge data,
- create, rotate or revoke API keys.

## Owner dashboard sessions

The administration dashboard ([`ww2web`](./admin-dashboard.md)) must not keep an
API key in the browser. Instead the owner **exchanges** an owner key for a
short-lived session:

```
POST /api/v1/ui/auth/login  { "apiKey": "wak_…" }
   -> Set-Cookie: ww2_owner_session=…; HttpOnly; SameSite=Strict; [Secure]
   -> { "data": { "csrfToken": "…", "owner": { … }, "expiresAt": "…" } }
```

| Property | Value |
| --- | --- |
| Credential required | A key holding **both** `auth:manage` and `keys:manage` (or `*`). A `messages:send` key is refused. |
| Session value | 32 random bytes; the cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` in production. |
| At rest | **Nothing.** Only an HMAC digest (keyed with `API_KEY_PEPPER`) is held, and only in memory. |
| Lifetime | `OWNER_SESSION_TTL_MS` absolute; `OWNER_SESSION_IDLE_MS` sliding idle timeout. |
| CSRF | State-changing requests from a session must send the `X-CSRF-Token` header; the token is returned by login/session and held in JS memory. |
| Endpoints | `GET /api/v1/ui/auth/session`, `POST /api/v1/ui/auth/logout` (cookie + CSRF only). |

Every session is revocable: revoking the API key that created it
(`revokeForKey`) also drops its sessions, and `POST /api/v1/ui/auth/logout`
removes it immediately. Restarting the service clears all sessions — the owner
signs in again.

## Bootstrapping keys (CLI)

There is no default key and no self-service creation. The **first** owner key is
created with the CLI, which uses the configured pepper and data directory
directly — a deliberate "you already have host access" boundary.

```bash
npm run key:create -- --preset owner --name owner       # all scopes
npm run key:create -- --preset service --name razorbills # messages:send
npm run key:revoke -- --key-id <keyId>
npm run key:rotate -- --key-id <keyId> [--grace-period-ms 300000]
```

See [Scripts](./scripts.md).

## Related

- [API reference](./api-reference.md)
- [Owner dashboard](./admin-dashboard.md)
- [Security](./security.md)
- [Errors](./errors.md)
