# Development

## Requirements and tooling

- Node.js ≥ 20.11, ESM, no build step.
- Express 5, zod for validation, pino for logging, helmet/cors for HTTP security.
- `whatsapp-web.js` + `puppeteer` are **optional** dependencies (web connector
  only).

## Getting a working tree

```bash
npm install --omit=optional     # skip the optional browser stack
cp .env.example .env
npm run dev                     # node --watch
npm test                        # unit + integration + security
```

## Running the WhatsApp Web connector locally

The Web connector is opt-in and needs the optional browser stack:

```bash
npm run setup:web-connector      # installs whatsapp-web.js + puppeteer
npx puppeteer browsers install chrome   # only if the postinstall download was blocked
```

Then set, in `.env`:

```dotenv
ENABLE_WHATSAPP_WEB_CONNECTOR=true
WHATSAPP_WEB_AUTHORIZATION_REFERENCE=<your written-authorisation record id>
```

Create a `web` instance and use **Connection → Start QR sign-in** to display a
QR code. The code is short-lived and is never stored by the dashboard.

If Chromium fails with `No usable sandbox!` (Ubuntu 23.10+ restricts
unprivileged user namespaces), prefer configuring the SUID sandbox or a
container capability. As a development-only fallback, set
`WHATSAPP_WEB_NO_SANDBOX=true`; it is never the default and weakens browser
isolation.

## Code conventions

- **ESM throughout**; one concern per module; JSDoc on entry-level functions.
- **No singletons.** Everything is constructed in the composition root
  (`src/container.js`) and passed explicitly. Nothing imports a shared instance.
- **Thin routes.** Routes validate, authorise and delegate. Business logic lives
  in `src/services`. Storage lives in `src/repositories`.
- **Validate every input** with zod, into `req.valid` — never read raw
  `req.query`/`req.body` downstream.
- **Fail with `AppError` subclasses** (`src/utils/errors.js`) so the central error
  handler can map them to stable codes. Never leak internals or secrets.
- **Never log secrets.** Rely on `src/utils/logger.js` redaction as a safety net,
  but do not pass secrets to the logger in the first place.
- **Filesystem access goes through `FileStore`** (`readJson`, `writeJson`,
  `updateJson`, `appendJsonl`, `updateJsonl`, ...). Do not call `fs` directly in
  services.
- **Paths are derived, never accepted.** Use `store.paths.*`; identifiers are
  validated and containment asserted.

## Adding an HTTP endpoint (checklist)

1. Define the request schema in `src/validators/` (or inline in the route).
2. Map the route to its required scope in `src/config/security.js`
   (`ROUTE_SCOPES`).
3. Add a thin handler in the relevant `src/routes/*.routes.js`, wired in
   `src/app.js` with `authenticate` → `requireScopes` → `validate` →
   `loadInstance` (as appropriate).
4. Put the logic in a service.
5. Add tests (integration at minimum) and update the docs.

## Adding a connector

1. Extend `WhatsAppConnector` from `src/connectors/connector.interface.js`.
2. Implement `getCapabilities()` **truthfully** and the operations you support;
   leave the rest to the base class (which raises
   `CapabilityNotSupportedError`).
3. Register it in `ConnectionService.buildConnector()` and, if it needs one, add
   its configuration to `src/config/env.js` and `src/config/security.js`.
4. Add it to any capability/endpoint mapping (`describeSupportedEndpoints`).
5. Add a unit test with an injected fake library/client.

### Capability honesty

A capability must reflect what the connector genuinely does today — never what it
might do. Unsupported operations must throw `CapabilityNotSupportedError`, which
the base class already does for you.

## Storage and concurrency rules

- Use `FileStore` for all persisted state — it provides atomic writes, the
  per-file mutex, corruption quarantine and temp sweeping.
- For read-modify-write, use `updateJson` / `updateJsonl` (they hold the mutex
  across the read and the write).
- For per-instance lifecycle operations, use the file lock
  (`locks.withLock(...)`); never start a second browser for an instance.
- Never delete a lock just because it is old — `fileLock` verifies the owner is
  gone.
- Add new files under `DATA_DIR` by extending `src/storage/paths.js` so paths stay
  validated.

## Testing conventions

- Use `tests/helpers/testApp.js` / `testStore.js`; each test gets a temp
  `DATA_DIR`.
- Inject fakes through `libraryFactory` (web) and `cloudClientFactory` (Cloud API)
  rather than hitting the network.
- Assert on the HTTP contract and on files under the temp data directory.
- For secret handling, capture logs in memory and assert absence.

See [Testing](./testing.md).

## The dashboard (`ww2web`)

The owner UI is a **separate, self-contained frontend package** inside this
repository. It is additive: the service keeps working, and keeps its full test
suite passing, whether or not the dashboard has been built.

- Source: `ww2web/` (JavaScript only, its own `package.json`, Vite + Tailwind +
  hand-written shadcn/ui components). Backend dependencies stay in the root
  `package.json`; the two dependency trees never mix.
- Publish: `npm run build:frontend` (root) builds and atomically replaces
  `public/frontend/`. Never copy files there by hand.
- Documentation: `docs/*.md` are copied into `ww2web/src/content/docs/` by
  `npm run sync:docs` (also run by the build). The generated directory is never
  edited by hand; the Documentation page reads its manifest and lazy-loads each
  document.
- Develop: `npm --prefix ww2web run dev` (Vite on 5173, proxying `/api` and
  `/health` to port 3000). Production is always the published bundle served by
  Express at `/ui/`.
- Adding a page: add a route in `ww2web/src/App.jsx`, a nav entry in
  `ww2web/src/components/layout/nav-items.js`, and the page module in
  `ww2web/src/pages/`. Call the API through `ww2web/src/lib/api.js` — never
  `fetch` directly, so CSRF handling and error shaping stay in one place.
- If a page needs data no endpoint provides, **add a real endpoint** under
  `/api/v1/ui` in `src/routes/ui.routes.js` and derive the view in
  `src/services/admin.service.js`. Never simulate state in the browser.

Security rules for anything added to the dashboard: never send secrets (or
filesystem paths) to the browser, never persist short-lived credentials, gate
every control on a real capability descriptor, and confirm every destructive
action. See [Owner dashboard](./admin-dashboard.md).

## Repository layout reminder

See [Architecture → Module layout](./architecture.md#module-layout) for the full
tree.

## Related

- [Architecture](./architecture.md)
- [Owner dashboard](./admin-dashboard.md)
- [Testing](./testing.md)
- [Connectors](./connectors.md)
