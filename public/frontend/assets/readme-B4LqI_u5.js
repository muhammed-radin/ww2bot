const e=`# razorbills-whatsapp — Documentation

A private, **single-owner**, **file-based** WhatsApp service for the RazorBills
backend. It exposes a small, auditable HTTP API over WhatsApp and ships two
connectors:

- **Official WhatsApp Business Platform (Cloud API)** — the default and the only
  connector suitable for production.
- **Authorised WhatsApp Web connector** — disabled by default, gated behind a
  written-authorization reference, and explicitly *not* an official WhatsApp API.

There is **no database and no Redis**. Every piece of state is a JSON/JSONL file
or an encrypted blob under \`DATA_DIR\`.

> This is not a multi-tenant product. There is no registration, no public auth
> page and no customer accounts. Only the owner may initialise WhatsApp
> authentication, view a QR code, request a pairing code, disconnect, or manage
> credentials. The RazorBills backend gets a narrowly scoped key
> (\`messages:send\`).

---

## How to read these docs

New to the project? Read them in this order:

1. [Getting started](./getting-started.md) — install, configure, first run, first keys.
2. [Architecture](./architecture.md) — how the pieces fit together.
3. [Configuration](./configuration.md) — every environment variable.
4. [Connectors](./connectors.md) — what each connector can and cannot do.
5. [Authentication](./authentication.md) — API keys, scopes, owner-only controls.
6. [API reference](./api-reference.md) — every endpoint.
7. [Owner dashboard](./admin-dashboard.md) — the \`ww2web\` administration UI.
8. [Operations](./operations.md) — runbook, backup/restore, troubleshooting.
9. [Deployment](./deployment.md) — Docker, Compose, production checklist.

## Full index

### Concepts

| Document | Contents |
| --- | --- |
| [Overview / index](./README.md) | This page. |
| [Getting started](./getting-started.md) | Requirements, install, configuration, first run, first API keys. |
| [Architecture](./architecture.md) | Module layout, request lifecycle, data flow, design principles. |
| [Configuration](./configuration.md) | Complete environment-variable reference with defaults and constraints. |
| [Connectors](./connectors.md) | Connector interface, \`cloud_api\`, \`web\`, capability matrix. |
| [Connection lifecycle](./connection-lifecycle.md) | State machine, reconnection, locks, browsers, startup recovery. |

### API

| Document | Contents |
| --- | --- |
| [API reference](./api-reference.md) | Every HTTP endpoint, request and response shapes. |
| [Owner dashboard](./admin-dashboard.md) | \`ww2web\`: build/publish, serving, routes, pages, sessions, dashboard API, bundled docs. |
| [Authentication](./authentication.md) | API keys, scopes, rotation, revocation, escalation guards. |
| [Outbound messaging](./outbound-messaging.md) | \`POST /messages/send\`, idempotency, honest statuses, limits. |
| [Real-time events (SSE)](./realtime-events.md) | Stream tokens, event types, stream hardening. |
| [Cloud API webhooks](./webhooks.md) | Meta verification handshake, signature verification, de-duplication. |
| [Errors](./errors.md) | Error envelope, stable codes and HTTP status mapping. |

### Data, security and operations

| Document | Contents |
| --- | --- |
| [Storage](./storage.md) | Data-directory layout, atomic writes, locks, corruption handling. |
| [Data retention and privacy](./data-retention.md) | Retention model, purge, what is and is not persisted. |
| [Security](./security.md) | Threat model, encryption at rest, redaction, HTTP hardening. |
| [Operations](./operations.md) | Runbook: deploy, backup/restore, maintenance, troubleshooting. |
| [Deployment](./deployment.md) | Docker, Compose, production checklist. |
| [Testing](./testing.md) | Test suite layout, how to run, live tests. |
| [Scripts](./scripts.md) | \`key:create\`, \`key:revoke\`, \`key:rotate\`, \`session:purge\`, \`sync:docs\`, \`build:frontend\`. |
| [Development](./development.md) | Code conventions, dependency injection, adding a connector. |

## At a glance

| Item | Value |
| --- | --- |
| Runtime | Node.js ≥ 20.11 (ESM, no build step), Express 5 |
| Stateful dependency | The filesystem at \`DATA_DIR\` (that's all) |
| Default connector | \`cloud_api\` (official WhatsApp Business Platform) |
| Auth | \`X-API-Key\` header only; pepper-keyed HMAC-SHA256 digests at rest |
| Dashboard auth | Owner API key exchanged for an in-memory session in an \`HttpOnly\` cookie, with CSRF on state-changing requests |
| Dashboard | \`ww2web\` (React + Vite), served by this process at \`/ui/\`; assets at \`/frontend/\` |
| Encryption at rest | AES-256-GCM keyring for session archives, message bodies, delivery recipients |
| Default port | \`3000\` |
| API base path | \`/api/v1\` |
| Health | \`/health/live\`, \`/health/ready\` |
| Single process | One process per \`DATA_DIR\` (no cross-process coordination) |

## Related documents

- [\`../README.md\`](../README.md) — the project README (project-level overview).
- [\`../.env.example\`](../.env.example) — the canonical configuration template.
`;export{e as default};
