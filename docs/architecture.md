# Architecture

## Design principles

1. **One stateful dependency: the filesystem.** No database, no Redis, no ORM,
   no migrations. Everything is a JSON/JSONL file or an encrypted blob under
   `DATA_DIR`.
2. **Single owner, single process.** One owner, one internal tenant
   (`DEFAULT_TENANT_ID`). Exactly one service process owns each `DATA_DIR`;
   cross-process coordination is not implemented.
3. **No business logic in route handlers.** Routes validate, authorise and
   delegate to services. Services own the logic. Repositories own storage.
4. **Honesty over convenience.** A connector advertises what it can genuinely do.
   Unsupported operations raise `CAPABILITY_NOT_SUPPORTED` (501) instead of
   returning invented data.
5. **Explicit dependency injection.** Nothing imports a singleton; the
   composition root (`src/container.js`) wires everything, so tests can build an
   isolated container with a temporary data directory and injected doubles.

## Module layout

```
src/
  server.js         Process entry point: config → container → HTTP → graceful shutdown
  app.js            Express assembly (middleware order, route mounting)
  container.js      Composition root — every dependency wired explicitly

  config/
    env.js          Environment parsing/validation, production fail-fast
    security.js     Scopes, route→scope map, helmet/CORS policy, redaction paths

  middleware/
    requestId.js    X-Request-Id accept/generate/echo
    apiKeyAuth.js   X-API-Key authentication + scope enforcement
    loadInstance.js Tenant-isolating instance loader (404 across tenants)
    validateRequest.js  zod validation into req.valid; shared schemas
    rateLimit.js    In-memory fixed-window limiters (store + factory)
    ipAllowlist.js  Optional source-IP allowlist (IPv4/IPv6/CIDR)
    errorHandler.js Central error mapping + 404 handler

  routes/           Thin HTTP handlers, one module per resource family
    health, instances, auth (SSE), chats, messages, outbound,
    webhooks, connectors, api-keys

  services/         Business logic
    instance.service.js       Instance lifecycle + tenant isolation
    apiKey.service.js         Key generation/verify/rotate/revoke + escalation guards
    connection.service.js     Connection orchestration + connector registry
    connectionState.js        State machine + backoff
    reconnection.service.js   Reconnect supervisor
    session.service.js        Session directory + encrypted archive
    messageStore.service.js   Retention-gated message persistence
    retention.service.js      Retention purge
    outbound.service.js       Outbound sends + idempotency
    webhook.service.js        Cloud API webhook processing
    streamToken.service.js    Single-use SSE stream tokens
    audit.service.js          Audit trail + redaction
    encryption.service.js     AES-256-GCM keyring

  connectors/
    connector.interface.js    The contract every connector implements
    cloudApi/                 Official WhatsApp Business Platform
      cloudApi.client.js      Minimal Graph API client
      cloudApi.connector.js   Connector implementation
    web/                      Authorised WhatsApp Web (opt-in)
      web.connector.js        whatsapp-web.js-backed connector
      browserManager.js       Chrome admission control + lifecycle
      sessionStore.js         Encrypted RemoteAuth store

  storage/
    paths.js        Validated path helpers (containment asserted)
    fileStore.js    Atomic JSON/JSONL I/O, corruption quarantine, temp sweep
    mutex.js        Keyed async mutex (per-file read-modify-write)
    fileLock.js     Per-instance locks with pid-verified stale recovery

  repositories/     File-backed data access over the storage primitives
    index.js        createRepositories({ store, encryption, logger })

  events/
    connectionEvents.js  In-process event bus (SSE + internal supervisors)

  utils/
    errors.js       Error taxonomy (AppError subclasses + ErrorCode)
    logger.js       pino logger + HTTP logger + URL sanitisation
    ids.js          CSPRNG identifier generation
    pagination.js   HMAC-signed opaque cursors
    respond.js      Uniform success envelope
    isMain.js       ESM "is this the entry module" check

scripts/            API-key administration, data-purge and frontend-publish CLIs
tests/              unit, integration, security, live
ww2web/             owner dashboard source (separate package.json; React + Vite)
public/frontend/    the published dashboard bundle served at /ui/
```

## Request lifecycle

Every request passes through a fixed middleware chain assembled in
`src/app.js`:

```
        ┌─────────────────────────────────────────────────────────────┐
        │ 1. requestIdMiddleware        assign/echo X-Request-Id        │
        │ 2. ipAllowlist (optional)     reject non-allowlisted IPs      │
        │ 3. pino-http (not in tests)   structured, redacted logging    │
        │ 4. helmet                     security headers                │
        │ 5. cors                       origin allowlist                │
        │ 6. express.json               strict size limit + raw body    │
        └─────────────────────────────────────────────────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 │                                       │
          public routes                            /api/v1 (protected)
     /health/*, /api/v1/webhooks/whatsapp       ipOnly limiter → authenticate
                                                       → requireScopes
                                                       → validate (zod → req.valid)
                                                       → loadInstance (tenant 404)
                                                       → route handler
                 │                                       │
                 └───────────────────┬───────────────────┘
                                     │
                         notFoundHandler → errorHandler
```

Key properties:

- **Validation happens once, into `req.valid`.** Downstream code never reads raw
  `req.query`/`req.body`, so unvalidated input cannot leak inward. Validation
  error details contain paths and messages only — never the offending value.
- **Tenant isolation is enforced by the loader.** A key that is not entitled to
  an instance receives **404** (identical to a missing instance), never 403, so
  instance ids cannot be probed across tenants.
- **Errors are centralised.** Every 4xx/5xx response has one shape; stack traces,
  filesystem paths and credentials never appear.

See [API reference → response envelope](./api-reference.md#response-envelope).

## Composition root

`createContainer({ config, logger, store, libraryFactory, cloudClientFactory })`
builds every service once and returns them plus a small lifecycle:

```js
const container = createContainer({ config, logger });
await container.start();      // init storage, reclaim stale locks, startup recovery
const app = createApp({ config, container });
// ... later ...
await container.shutdown();   // stop supervisors, close browsers, sweep temp files
```

- `start()` is idempotent. It initialises storage, reclaims locks left by a dead
  process, writes a non-secret `service.json`, subscribes the connection and
  reconnection services to the event bus, and runs `recoverOnStartup()`.
- `shutdown()` never throws. It stops the reconnection supervisor, destroys
  connectors / closes browsers, closes the event bus, clears in-memory limiter
  and token stores, and sweeps leftover temp files.

Tests inject `store` (a temp `FileStore`), `libraryFactory` (a fake
`whatsapp-web.js`) and `cloudClientFactory` (a fake fetch-based client) to
exercise the real code paths without a browser or network.

## Service relationships

```
                         ┌──────────────┐
        HTTP routes ───► │ InstanceService │  instance CRUD, tenant guard
                         └──────┬───────┘
                                │
   ┌────────────────────────────┴─────────────────────────────┐
   │                                                           │
┌──▼───────────────────┐                          ┌────────────▼────────────┐
│ ConnectionService     │  registry of connectors  │  ReconnectionService    │
│ connect/reconnect/    │◄──── event bus ─────────►│  backoff supervisor      │
│ disconnect/delete     │                          └─────────────────────────┘
│ + per-instance lock   │
└──┬───────────┬────────┘
   │           │
   │           └────────────► SessionService (dir + encrypted archive)
   │
   ▼
┌──────────────────────────────┐   ┌────────────────────┐   ┌──────────────────┐
│ Connector (cloud_api | web)  │   │ OutboundService     │   │ WebhookService    │
│ getCapabilities(), lifecycle │   │ send + idempotency  │   │ Cloud API inbound │
└──────────────────────────────┘   └────────────────────┘   └──────────────────┘
                    │                        │                        │
                    └────────────────────────┴────────────────────────┘
                                             │
                                   ┌─────────▼──────────┐
                                   │  Repositories      │  file-backed
                                   │  (FileStore)       │
                                   └────────────────────┘
```

### Two-way server→broker direction

- **Outbound** (`messages:send` → `OutboundService` → connector → Cloud API /
  linked device).
- **Inbound** (`POST /api/v1/webhooks/whatsapp` → `WebhookService` → optional
  `MessageStoreService` → event bus).

### The event bus

`ConnectionEventBus` is in-process only. Connectors publish events; it delivers
them to:

- per-instance **SSE subscribers** (authorised clients), and
- **global subscribers** (the connection-state writer and the reconnection
  supervisor).

Listeners are **awaited**, so a connector that publishes a status change cannot
race the synchronous state transition that follows it. The most recent event per
instance is cached for a few minutes so a client that connects a moment late
still learns the current state. See
[Real-time events](./realtime-events.md).

## Concurrency model

| Concern | Mechanism | Where |
| --- | --- | --- |
| Atomic file writes | temp file + `fsync` + rename | `storage/fileStore.js` |
| Per-file read-modify-write | keyed async mutex | `storage/mutex.js` |
| Per-instance lifecycle ops | file lock (pid-verified stale recovery) | `storage/fileLock.js` |
| One browser per instance | `BrowserManager` slots + admission limit | `connectors/web/browserManager.js` |
| One reconnect attempt per instance | `inFlight` guard | `services/reconnection.service.js` |
| Rate limits | in-memory fixed window (per key + IP) | `middleware/rateLimit.js` |

Details in [Storage](./storage.md) and
[Connection lifecycle](./connection-lifecycle.md).

## What lives in memory only

These reset when the process restarts; that is expected and documented:

- Rate-limit counters.
- Single-use SSE stream tokens.
- The connector registry and open browsers (browsers are closed on shutdown).
- The event bus and its last-event cache.

Everything that must survive a restart (instances, connection state, sessions,
retained messages, delivery metadata, audit events, API keys) is on disk.
