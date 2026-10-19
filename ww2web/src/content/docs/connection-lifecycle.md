# Connection lifecycle

Each instance owns one connector session. The connection state is explicit,
persisted, and recoverable across restarts.

## States

`ConnectionState` (persisted in `connection.json` as `state`):

```
DISCONNECTED ─► INITIALIZING ─► QR_REQUIRED ─► AUTHENTICATING ─► CONNECTED
                                   │                 │
                                   └── RECONNECTING ◄┘
                                            │
                                            ▼
                                          ERROR   (needs the owner)
```

| State | Meaning |
| --- | --- |
| `DISCONNECTED` | Not running. Reconnection is not scheduled for operator-initiated disconnects. |
| `INITIALIZING` | A connect/reconnect is starting. |
| `QR_REQUIRED` | Waiting for the owner to scan a QR challenge. |
| `AUTHENTICATING` | Credentials/pairing are being confirmed. |
| `CONNECTED` | Live session (Cloud API: credentials verified). |
| `RECONNECTING` | A supervised reconnect is scheduled or running. |
| `ERROR` | Terminal for the automatic policy: owner intervention required. |

`LIVE_STATES` = `[INITIALIZING, QR_REQUIRED, AUTHENTICATING, CONNECTED, RECONNECTING]`
— the states that mark an instance as "was live" for startup recovery.

### Instance status vs. connection state

The persisted **connection state** is mirrored onto the instance's public
**status** so the instance list stays meaningful:

| Connection state | Instance status |
| --- | --- |
| `INITIALIZING` | `initializing` |
| `RECONNECTING` | `reconnecting` |
| `QR_REQUIRED` | `awaiting_qr` |
| `AUTHENTICATING` | `authenticated` |
| `CONNECTED` | `ready` |
| `ERROR` | `error` |
| `DISCONNECTED` | `disconnected` |

`created` and `awaiting_pairing_code` and `destroyed` are instance statuses
without a one-to-one connection-state mapping.

### Web session sub-phases (streamed, not persisted)

`AUTHENTICATING` covers the whole post-scan window. The web connector streams
finer-grained progress without touching the persisted state machine:

| Event | Meaning |
| --- | --- |
| `auth.qr` / `auth.qr_expired` | A QR challenge was issued / the displayed one expired. WhatsApp rotates codes; each rotation is a new `auth.qr`. |
| `auth.state` | The library's own connection state (`OPENING`, `PAIRING`, `CONNECTED`, …). |
| `auth.loading` | Post-authentication chat sync progress (`percent`, `message`, `complete`) from the library's `loading_screen`. |

These are display-only: they are delivered over SSE and mirrored into
`GET /status` as `details.loading` and `details.authState`, but they never write
the connection state.

## What is persisted

`DATA_DIR/instances/<id>/connection.json` contains operational metadata only:

```json
{
  "state": "CONNECTED",
  "attempt": 0,
  "lastError": null,
  "reason": null,
  "updatedAt": "...",
  "lastAttemptAt": null,
  "nextAttemptAt": null,
  "connectedAt": "...",
  "disconnectedAt": null
}
```

It never contains QR payloads, pairing codes, cookies or any session material.

## Connect / reconnect / disconnect

All lifecycle operations run under the **per-instance lock**
(`instance:<id>:connect`), so two requests cannot start the same browser twice or
race an operator action against a supervised reconnect.

- `connect()` writes `INITIALIZING`, creates or reuses the connector, calls the
  connector's `initialize()` / `requestQrAuth()` / `requestPairingCode()`.
  - Loading an already-active session returns the current status.
  - Busy lock → `409 INSTANCE_BUSY`.
  - Failure → `ERROR` with a redacted `lastError`.
- `reconnect()` is the supervisor's entry point. It runs under the same lock,
  calls `resetForReconnect()` on connectors that hold a long-lived client, writes
  `RECONNECTING`, then re-initialises.
- `disconnect({ logout })` stops the connector; `logout: true` also destroys the
  stored session. Either way the state becomes `DISCONNECTED`.

### Ordering guarantee

The event bus **awaits** every listener. A connector that publishes a status
event cannot race the synchronous state transition that follows it (for example,
a late `initializing` must not overwrite the `CONNECTED` state a completed
connect writes moments later). See [Architecture → The event bus](./architecture.md#the-event-bus).

### Guard against state flapping

When reconnection is enabled:

- Recoverable `DISCONNECTED`/`ERROR` events are owned by the supervisor (which
  writes `RECONNECTING` or, once the budget is spent, `ERROR`), so the connection
  service does not overwrite them.
- A connector's asynchronous `initializing` status is **ignored** if the current
  state is `RECONNECTING` or a terminal `ERROR` — otherwise the instance list
  would flap after recovery gave up.

## Automatic reconnection

`ReconnectionService` subscribes to the event bus and reacts to **recoverable**
disconnects/errors.

- **Backoff**: exponential with jitter, capped by `RECONNECT_MAX_DELAY_MS`.
  `backoffDelay(attempt) = min(base * 2^(attempt-1), max)` ± up to `jitter`.
- **Bounds**: `RECONNECT_MAX_ATTEMPTS` and `RECONNECT_MAX_DURATION_MS`. Exhausting
  either moves the instance to a visible **ERROR** and stops — there is **no
  infinite rapid reconnect loop**.
- **Stability reset**: a connection that stays `ready` for
  `RECONNECT_STABLE_RESET_MS` clears the attempt counter and the scheduled state.
- **One attempt per instance**: an `inFlight` guard ensures a single attempt at a
  time, even under event churn. A per-attempt failure never clobbers a terminal
  `ERROR` written when the budget was exhausted.
- **Intentional disconnects don't reconnect**: the web connector marks
  operator-initiated teardown so a library `disconnected` event raised during it
  is not treated as a recoverable drop (`recoverable: false`).

`RECONNECT_ENABLED=false` disables the supervisor entirely.

## Startup recovery

On `container.start()` the supervisor runs `recoverOnStartup()`:

1. Nothing is running after a restart, so any instance previously in a
   `LIVE_STATE` is first persisted as `DISCONNECTED` (reason `process_restart`).
2. If `RECONNECT_ENABLED` and `AUTO_RECONNECT_ON_STARTUP` are both on **and** the
   instance is `cloud_api` and `wasLive`, one reconnect is scheduled.
3. The **web** connector always requires the owner to re-initiate, so a restart
   never generates an unsolicited QR code.

Return value: `{ instances, scheduled }`.

## Browser ownership

`BrowserManager` guarantees **exactly one browser per instance**:

- `reserve(instanceId)` throws `409 INSTANCE_BUSY` if the instance already has a
  slot, and `409 INSTANCE_LIMIT_REACHED` if `MAX_BROWSER_INSTANCES` is reached.
- `attach()` binds the client/browser to the reserved slot.
- `release(id, { destroy })` closes the client and browser, with a per-operation
  timeout, and never throws.
- `closeAll()` closes every browser on shutdown.

Admission control runs **before** any state change, so a rejected start leaves
the connector as it was and never leaks the `launching` flag.

## Locks

`storage/fileLock.js` provides per-instance locks:

- The authoritative guard is an **in-memory** map — a single process only. A
  small lock file records *who* owns the key.
- A stale lock is reclaimed **only after verifying the owning process is gone**
  (pid check) or, for the current process, that the in-memory owner no longer
  holds the token. A lock is **never** deleted merely because it looks old.
- Stale locks are swept at startup via `cleanupStale()`.
- `withLock(key, fn, { ttlMs, waitMs })` throws `INSTANCE_BUSY` immediately unless
  `waitMs` is set. A heartbeat refreshes the acquisition time for long
  operations.

See [Storage → Locks](./storage.md#locks).

## Graceful shutdown

On `SIGTERM`/`SIGINT` (or an uncaught exception) the server:

1. stops accepting connections,
2. lets in-flight requests finish (then force-closes SSE streams),
3. runs `container.shutdown()`:
   - stops the reconnection supervisor,
   - destroys connectors and closes all browsers,
   - closes the event bus,
   - clears in-memory limiter and token stores,
   - sweeps leftover temp files.

A hard timeout (`SHUTDOWN_TIMEOUT_MS`) guarantees the process always exits.

## Related

- [Connectors](./connectors.md)
- [Real-time events](./realtime-events.md)
- [Storage → Locks](./storage.md#locks)
- [Operations → Troubleshooting](./operations.md#troubleshooting)
