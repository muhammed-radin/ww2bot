# Real-time events (SSE)

Live connection status and authentication challenges are delivered over
Server-Sent Events (SSE).

Browser `EventSource` cannot send an `X-API-Key` header, and a long-lived API key
must never be placed in a URL. Instead a client exchanges its key for a
**single-use stream token** and passes *that* in the query string.

## Flow

### 1. Issue a stream token — scope `connection:read`

```
POST /api/v1/instances/:instanceId/auth/stream-token
X-API-Key: <key>
```

```json
{
  "success": true,
  "data": {
    "token": "…",
    "expiresAt": "…",
    "expiresInMs": 60000,
    "eventsEndpoint": "/api/v1/instances/ins_.../auth/events",
    "singleUse": true,
    "note": "The token is single-use, bound to this instance, and expires shortly."
  }
}
```

The token is bound to `{ keyId, tenantId, scopes, allowedInstanceIds, instanceId }`
and stored only as a SHA-256 digest. It expires after `STREAM_TOKEN_TTL_MS` and
can be consumed **exactly once**. Issuing a new token invalidates nothing but the
old one is unaffected until it expires or is used.

### 2. Open the stream

```
GET /api/v1/instances/:instanceId/auth/events?streamToken=<token>
```

- The `X-API-Key` header is also accepted (for streaming `fetch`).
- A stream token must match the instance in the path.
- Consuming an unknown, expired or already-used token → `401` with code
  `INVALID_STREAM_TOKEN`.
- Wrong instance → `401 INVALID_STREAM_TOKEN`.

## Stream format

```
retry: 5000

event: stream.ready
data: {"instanceId":"ins_...","connector":"web","at":"..."}

id: evt_...
event: auth.qr
data: {"connector":"web","attempt":1,"expiresAt":"...","ttlMs":45000,"qrDataUrl":"data:image/png;base64,..."}

: heartbeat 1712345678901

event: connection.status
data: {"status":"ready","connector":"web","details":{...}}
```

- Each event carries an `id` (the event id).
- A `retry: 5000` hint and periodic comment heartbeats keep intermediaries from
  idling the connection out.
- The stream is closed after `SSE_MAX_STREAM_MS` with a final
  `stream.closed` event (`reason: "max_duration_reached"`).
- A late subscriber is replayed the **most recent** event for the instance (a
  short-lived cache), so it is never left blind.

## Event types

| Event | Data highlights |
| --- | --- |
| `stream.ready` | `instanceId`, `connector`, `at`, and a `snapshot` of the current status (synthetic, first frame). |
| `auth.qr` | `qrDataUrl`, `expiresAt`, `ttlMs`, `attempt`. Re-issued whenever WhatsApp rotates the code. |
| `auth.qr_expired` | The current QR challenge expired. A fresh `auth.qr` follows while the session is still open. |
| `auth.pairing_code` | `pairingCode`, `expiresAt`. |
| `auth.loading` | Post-authentication sync progress: `percent`, `message`, `complete`. Sourced from the library's `loading_screen`; never extrapolated. |
| `auth.state` | The library's own connection state (for example `OPENING`, `CONNECTING`, `CONNECTED`). |
| `connection.authenticated` | `status`, `connector`. |
| `connection.status` | `status`, `connector`, optional `details`. |
| `connection.state` | A state-machine transition. |
| `connection.reconnecting` | `state`, `attempt`, `nextAttemptAt`, `reason`. |
| `connection.disconnected` | `reason`, `recoverable`. |
| `connection.error` | `message`, `recoverable`. |
| `message.received` | `connector`, `chatId`, `messageId`, `type`, `timestamp`, `contentRetained` — **metadata only**, never the body (Cloud API). |
| `message.sent` | Same shape as `message.received` for a message the gateway or the linked account sent. |
| `connector.metric` | Connector-specific metric (for example an outbound send result). |
| `stream.closed` | `reason`. |

### Message events and content

`message.received` and `message.sent` are emitted for incoming and outgoing
traffic respectively.

- **Cloud API:** metadata only (`contentRetained` reports whether the body was
  written to the retention store). Fetch the body from
  `GET /api/v1/instances/:instanceId/messages` when retention is on.
- **WhatsApp Web:** the event also carries the `body`, because the linked
  device already exposes that content over the authenticated read API. The body
  is only written to disk when retention is enabled.

Either way, automatic replies are evaluated inside the connector from the
message body directly; they never depend on the event stream. See
[Automatic replies](./api-reference.md#automatic-replies).

## Security & hardening

- **No long-lived key in a URL.** Only the single-use, short-lived stream token.
- The token is stored as a digest and consumed atomically.
- Streams are capped at **10 concurrent streams per instance**; exceeding this is
  `429 RATE_LIMITED`.
- Authorization is re-checked on every stream request (`connection:read`).
- The stream is closed after `SSE_MAX_STREAM_MS`; cleanup unsubscribes from the
  bus and clears timers on `close`, `aborted` and `error`.
- No QR/pairing challenge is delivered after authentication, expiry or
  cancellation.
- Query strings carrying a `streamToken` are **redacted in request logs**.
- Stream tokens are in-memory only and reset on restart.

## Client example

```js
const tokenRes = await fetch(`${base}/api/v1/instances/${id}/auth/stream-token`, {
  method: 'POST',
  headers: { 'X-API-Key': apiKey },
});
const { data } = await tokenRes.json();

const es = new EventSource(
  `${base}/api/v1/instances/${id}/auth/events?streamToken=${data.token}`,
);
es.addEventListener('auth.qr', (e) => renderQr(JSON.parse(e.data).qrDataUrl));
es.addEventListener('auth.qr_expired', () => markQrRefreshing());
es.addEventListener('auth.loading', (e) => setSyncProgress(JSON.parse(e.data).percent));
es.addEventListener('connection.status', (e) => updateStatus(JSON.parse(e.data)));
```

A token is consumed when the stream is opened, so reconnect by issuing a new
token.

## Related

- [API reference → Real-time events](./api-reference.md#real-time-authentication-events)
- [Connection lifecycle](./connection-lifecycle.md)
- [Configuration → Real-time event streams](./configuration.md#real-time-event-streams)
