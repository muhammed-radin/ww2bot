# Testing

The test suite is hermetic: **no database, no Redis, no browser and no network**.
Each test gets its own temporary `DATA_DIR` (so the real file-backed repositories
are exercised), and a fake `whatsapp-web.js` module covers the real connector
code paths. Nothing in `npm test` talks to WhatsApp.

## Running

```bash
npm test                    # unit + integration + security
npm run test:unit
npm run test:integration
npm run test:security
```

The scripts use `node --test` with glob patterns (Node ≥ 20; `node --test <dir>`
is not used because the project targets Node 24 where directory arguments are not
supported).

### Live tests (opt-in)

```bash
WA_GATEWAY_LIVE_TESTS=1 npm run test:integration:live
```

Live tests under `tests/live/` are excluded from `npm test`. Each one skips with
an explicit reason when its environment is missing, so CI never reports a false
pass. See [`../tests/live/README.md`](../tests/live/README.md).

## Layout

```
tests/
  helpers/
    testApp.js         Base env + temp DATA_DIR + app/server harness
    testStore.js       Temp FileStore + repositories + encryption helper
    fakeWhatsAppWeb.js Fake whatsapp-web.js for the web connector
  unit/                Pure/module-level tests
  integration/         HTTP-level tests through the Express app
  security/            Cross-cutting security assertions
  live/                Opt-in, real-network tests (excluded by default)
```

## What is covered

### Unit (`tests/unit/`)

| File | Focus |
| --- | --- |
| `apiKey.test.js` | Key format, parsing, hashing, verification, scopes, rotation/revocation. |
| `auditRedaction.test.js` | Recursive audit redaction of secrets and message content. |
| `cloudApiConnector.test.js` | Capabilities, credential verification, sends, unsupported ops. |
| `config.test.js` | Env parsing, validation, production fail-fast rules. |
| `connectionState.test.js` | State mapping and backoff delay/jitter. |
| `encryption.test.js` | AES-256-GCM round-trip, AAD, tamper detection, keyring. |
| `fileStore.test.js` | Atomic writes, corruption quarantine, JSONL read-modify-write. |
| `isMain.test.js` | ESM entry-module detection (paths with spaces). |
| `lock.test.js` | Per-instance file lock: acquire/release/timeout/stale recovery. |
| `pagination.test.js` | Signed opaque cursors, tamper rejection, kind scoping. |
| `sessionStore.test.js` | Encrypted RemoteAuth session store. |
| `streamToken.test.js` | Single-use, short-lived stream tokens. |
| `webConnector.test.js` | Web connector behaviour against the fake library. |
| `webhookService.test.js` | Signature verification, de-duplication, retention gating. |

### Integration (`tests/integration/`)

| File | Focus |
| --- | --- |
| `apiKeys.test.js` | Key CRUD over HTTP, scope enforcement, **scope-escalation prevention**. |
| `auth.test.js` | Authentication, missing/malformed/expired/revoked keys. |
| `connect.test.js` | Connect/reconnect/disconnect flows, duplicate-browser prevention. |
| `data.test.js` | Read-only chats/messages/contacts, capability gating, pagination. |
| `health.test.js` | Liveness/readiness, storage probe. |
| `instances.test.js` | Instance lifecycle, tenant isolation. |
| `outbound.test.js` | Send flow, idempotency, statuses, capability gating. |
| `persistence.test.js` | State survives a simulated container restart. |
| `ratelimit.test.js` | Per-key/per-IP/per-recipient limits and headers. |
| `reconnection.test.js` | Backoff, bounds, terminal ERROR, stable reset. |
| `retention.test.js` | Retention gating, purge, maintenance sweep. |
| `shutdown.test.js` | Graceful shutdown closes browsers and sweeps temp files. |
| `webAuthFlow.test.js` | QR/pairing flow, challenge expiry, owner-only access. |
| `webhooks.test.js` | Handshake, signature, de-duplication, unmatched instances. |
| `frontend-serving.test.js` | `/ui` → `/ui/` redirect, SPA shell (or not-built `503`), dashboard CSP, JSON 404s, API routes untouched. |
| `ui-api.test.js` | Dashboard endpoints: overview, redacted config, sanitised audit, deliveries, connector discovery with the web connector on and off. |

### Security (`tests/security/`)

| File | Focus |
| --- | --- |
| `headers.test.js` | Helmet headers, CORS, and the optional IP allowlist. |
| `isolation.test.js` | Cross-tenant access returns 404; allowlist enforcement. |
| `owner-session.test.js` | Owner login exchange, cookie/session handling, CSRF enforcement, non-owner keys refused. |
| `secrets.test.js` | Secrets are asserted absent from logs and error bodies. |

## Test harness

`tests/helpers/testApp.js` provides a base environment and a temp `DATA_DIR`, and
starts a real HTTP server around the app. `tests/helpers/testStore.js` builds a
temp `FileStore` + repositories + encryption for service-level tests.

Key environment defaults used by the harness (see the file for the exact values):
`LOG_LEVEL=silent`, `NODE_ENV=test`, a test `API_KEY_PEPPER`, an inline
`ENCRYPTION_KEYS` keyring, test CORS origins, high rate limits, the web connector
enabled with a test authorization reference, a small `MAX_BROWSER_INSTANCES`,
`AUTO_RECONNECT_ON_STARTUP=false`, and a per-test temp `DATA_DIR`.

## Writing a test

- Use the harness to get an app + server + temp data directory; never share state
  between tests.
- Assert on the public HTTP contract and on files under the temp `DATA_DIR`.
- For secret-handling tests, capture logs into an in-memory destination and assert
  the secret never appears.
- For the web connector, inject the fake library through `libraryFactory` rather
  than requiring `whatsapp-web.js`.

## Related

- [`../tests/live/README.md`](../tests/live/README.md)
- [Development](./development.md)
- [Architecture](./architecture.md)
