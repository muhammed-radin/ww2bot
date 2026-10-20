# Owner dashboard (ww2web)

`ww2web` is a React + Vite + shadcn/ui administration dashboard for the owner of
this service. It is **part of this repository and served by this same Express
process** — there is no second server, no second port, no database and no Redis.

```
ww2web/                     frontend source (its own package.json, JavaScript only)
  src/
    pages/                  one module per route
    components/ui/          shadcn/ui primitives (hand-written)
    components/common/      shared status/empty/loading/confirm building blocks
    components/layout/      sidebar, mobile drawer, topbar
    hooks/                  auth, theme, api, status, preferences, SSE events
    lib/                    api client, formatters, class helper, docs catalogue
    content/docs/           generated copy of docs/ (see `npm run sync:docs`)
  dist/                     Vite output (intermediate; git-ignored)
public/frontend/            the published build the service serves
scripts/sync-docs.js        copy docs/ into the frontend (npm run sync:docs)
scripts/build-frontend.js   build + publish (npm run build:frontend)
```

## Build and publish

The gateway has no build step of its own; the dashboard does.

```bash
npm --prefix ww2web install    # once
npm run build:frontend         # build ww2web, verify, then publish
npm start                      # http://localhost:3000/ui/
```

`npm run build:frontend` runs `vite build` inside `ww2web/`, checks that
`dist/index.html` exists **and** references the `/frontend/` asset base, copies
the *contents* of `dist/` into a staging directory, and only then swaps
`public/frontend/` into place. Consequences:

- a failed build publishes nothing;
- `public/frontend/index.html` always exists at the top level (never
  `public/frontend/dist/index.html`);
- unrelated files in `public/` are never touched;
- the operation is a same-filesystem directory rename, so it is atomic.

Before Vite runs, the same script calls `scripts/sync-docs.js`, which copies
`docs/*.md` into `ww2web/src/content/docs/` and regenerates the manifest
(`index.json`) used by the Documentation page. The in-app copy therefore cannot
drift from the repository. While working with the Vite dev server, run
`npm run sync:docs` after editing a document.

If the dashboard has never been published, the service still starts: `GET /ui/`
returns a `503` HTML page telling the operator to run `npm run build:frontend`.

For local UI work, `npm --prefix ww2web run dev` starts Vite on
`http://localhost:5173` and proxies `/api` and `/health` to the gateway on port
3000. The dev server is never used in production.

## Serving

| Path | Behaviour |
| --- | --- |
| `GET /ui` | `308` permanent redirect to `/ui/` |
| `GET /ui/` | `public/frontend/index.html`, `Cache-Control: no-store` |
| `GET /frontend/*` | hashed JS/CSS/font assets; `index: false`, `dotfiles: "deny"`, `1h` cache |
| `GET /frontend/<missing>` | JSON `404` (`NOT_FOUND`), never an Express error page |

The routes are mounted with `express.Router({ strict: true })`, so `/ui` and
`/ui/` are distinct and cannot redirect to each other forever. `mountFrontend`
is registered after the JSON API routers and before the error handlers, so it
can never shadow `/api/v1/*`.

Vite's asset base is `/frontend/` even though the app opens at `/ui/`: the HTML
shell is served from `/ui/` while its assets resolve to `/frontend/assets/…`.
The dashboard gets a same-origin Content-Security-Policy (see
[Security](./security.md)) distinct from the JSON API's `default-src 'none'`:
scripts must be same-origin external bundles (no `unsafe-inline`, no
`unsafe-eval`), styles may be inline, and images may be `data:`/`blob:` so the
QR code can be rendered.

The SPA uses a **HashRouter**, so all client routes live behind `#/`. Only one
HTML file is ever requested, which means the server needs no history fallback
and there is no path that could be coerced into serving an arbitrary file.

## Signing in

The dashboard has no credentials of its own. At `#/login` the owner enters an
**owner API key** (`wak_…`), which the server verifies with the same
`ApiKeyService` used by `X-API-Key` and exchanges for a session.

- A key must hold **both** `auth:manage` and `keys:manage` (or `*`). The
  RazorBills `messages:send` key can never sign in.
- The key is used once, is never written to `localStorage`/`sessionStorage`, and
  is never embedded in the bundle.
- The session lives in an `HttpOnly`, `SameSite=Strict` (`Secure` in production)
  cookie that page JavaScript cannot read.
- Only an HMAC digest of the session value is stored, and only in memory — no
  session material is written to disk.
- State-changing requests carry a per-session CSRF token returned by the login
  and session endpoints; it is held in JavaScript memory only.
- A page reload re-validates the session against `GET /api/v1/ui/auth/session`.
  An unauthenticated visitor is redirected to `#/login`; an authenticated one is
  sent to `#/dashboard`.

Details: [Authentication](./authentication.md#owner-dashboard-sessions).
Tuning: `OWNER_SESSION_TTL_MS`, `OWNER_SESSION_IDLE_MS`, `OWNER_SESSION_MAX`,
`OWNER_SESSION_COOKIE_SECURE` in [Configuration](./configuration.md).

## Routes

| Hash route | Page |
| --- | --- |
| `#/login` | Owner sign-in |
| `#/dashboard` | Service and connection summary |
| `#/connection` | Sign-in, QR and pairing controls, live events |
| `#/instances` | Create, inspect, delete instances |
| `#/chats` | Advanced conversations: history, live messages, media and rich sends |
| `#/chats/:chatId` | A specific conversation (deep link) |
| `#/messaging` | Delivery activity and a confirmed test send |
| `#/autoreplies` | Automatic-reply rules for incoming messages |
| `#/data` | Read-only chats, messages and contacts, plus a live feed |
| `#/config` | Read-only effective configuration |
| `#/security` | API keys and owner access |
| `#/logs` | Audit trail |
| `#/settings` | Dashboard preferences, session, diagnostics |
| `#/docs` | Bundled documentation index |
| `#/docs/:docId` | One rendered document |

## What each page does

### Dashboard (`#/dashboard`)

Reads `GET /api/v1/ui/overview` (every 15 s by default; adjustable in Settings)
plus `GET /health/ready`. Shows the service version and environment, total
instances and how many are ready, dependency readiness, browser-instance usage,
the primary connection (state, live process, linked account, last error, next
reconnect), the eight most recent audit events and five most recent deliveries,
and quick links.

### Connection (`#/connection`)

One instance is selected at a time. The page polls
`GET /api/v1/instances/:id/status` every 5 s, reads
`GET /api/v1/instances/:id/capabilities`, and subscribes to
`GET /api/v1/instances/:id/auth/events` over SSE (the owner session cookie
authorises the stream, so no stream token is needed).

| Capability | Behaviour |
| --- | --- |
| `qrAuth` | "Start QR sign-in" calls `POST .../connect/qr`. The QR image is displayed and **replaced live over SSE** every time WhatsApp rotates it; an expiry countdown is shown, and an expired frame is dimmed behind a "refreshing" overlay until the next code arrives. |
| `pairingCode` | A phone-number form calls `POST .../connect/pairing-code`; the returned code is displayed with an expiry countdown and a copy button. |
| neither | The controls are replaced with an explanation (the Cloud API has no interactive sign-in). |

The **Authentication session** card renders the live phase — start browser →
QR issued → device linked → sync chats → ready — driven by the streamed
`connection.status`, `auth.qr`, `auth.authenticated`, `auth.loading` and
`auth.state` events. Post-authentication chat sync shows the percentage the
library actually reports (`auth.loading.percent`), never a fabricated one, and
the `stream.ready` frame carries a status snapshot so a page opened mid-session
is immediately up to date.

A browser cold start can take tens of seconds, so `connect/qr` and
`connect/pairing-code` use a longer client timeout (120 s) than ordinary
requests, and a start that has not produced a code yet reads as "waiting for
WhatsApp", never as a failure.

Hard rules enforced by the UI:

- the QR payload and the pairing code are held in React state only, are dropped
  when sign-in succeeds or the instance changes, and are **never** written to
  storage; an expired QR frame is retained only behind a non-scannable
  "refreshing" overlay until the next streamed code replaces it;
- SSE events are stripped of `qrDataUrl` / `pairingCode` before they enter the
  event list;
- the page states plainly that the authorised WhatsApp Web connector is not an
  official WhatsApp API and requires a written-authorisation record.

Disconnect calls `POST .../disconnect`, with an optional "also log out the
device" switch, behind a confirmation dialog that spells out which of the two
irreversible outcomes will happen.

The stored-session card also offers **Revoke stored session**
(`DELETE /api/v1/instances/:id/session`). It disconnects the instance with a
logout and deletes every local trace of the authentication material — the
browser profile directory and the encrypted session archive — while keeping the
instance, its retained messages and its configuration. The confirmation states
that the device must be linked again.

### Instances (`#/instances`)

Lists instances with connector, status, retention and creation time. The detail
dialog re-reads `GET /api/v1/instances/:id`, so the status and capability badges
come from the authoritative view rather than the table row, lists the 25 most
recent events for that instance from
`GET /api/v1/instances/:id/audit-events`, and offers a confirmed
`POST /api/v1/instances/:id/data/purge`. Purging deletes retained messages,
webhook events and delivery records while keeping the instance, its WhatsApp
session and its configuration.

Creation goes through `POST /api/v1/instances`; deletion goes through
`DELETE /api/v1/instances/:id` behind a confirmation that names the instance and
states that all stored data goes with it.

The connector picker offers `web` only when
`GET /api/v1/connectors` reports it as enabled, so the UI cannot be used to
request a capability the host has switched off. The picker defaults to `web`
when the Web connector is enabled but Cloud API credentials
(`META_ACCESS_TOKEN` / `META_PHONE_NUMBER_ID`) are not configured, and the page
says so, so a new instance is not created against a connector that cannot
authenticate on that host.

### Chats (`#/chats`, `#/chats/:chatId`)

A full-bleed conversation page with a chat-list sidebar and a thread pane. The
selected instance comes from `GET /api/v1/instances`; capabilities come from
`GET /api/v1/instances/:id/capabilities` and gate every control. The chat list
reads `GET .../chats` (silently refreshed every 30 s and immediately on live
events), and the thread reads `GET .../chats/:chatId/messages`. On the Cloud API
these reads are available only while retention is enabled and only for messages
this gateway recorded.

Live messages arrive over the same authenticated SSE stream used by the
Connection page (`message.received` / `message.sent`). A message for the open
chat refreshes the thread; a message for another chat refreshes the list and, if
the tab is hidden, raises a small notification. Opening a chat marks it seen on
the linked device when `markChatSeen` is true; failures are ignored because read
receipts are best-effort.

Rendered message types: text, image, video, audio, voice notes, documents,
stickers, locations, contact cards, native polls, call logs, quoted messages,
reactions, edited markers, and deleted/system notices. Media is fetched lazily
as raw bytes with the owner cookie, displayed through an in-memory object URL,
and can be opened in a lightbox or downloaded. `404 MEDIA_UNAVAILABLE` is shown
with its explanation, never as a broken image.

The composer supports:

- text with Enter to send and Shift+Enter for a newline, an emoji picker and
  quoted replies;
- attachments (photo, video, audio, document), captioning, file-size checks
  against `maxMediaUploadBytes`, and an optional "send as voice note" flag for
  audio;
- in-browser voice recording through `MediaRecorder`; the exact produced MIME
  type is reported to the server, and a microphone-permission refusal is stated
  plainly;
- native poll, static location (including "use my current location") and contact
  card dialogs, each gated on the connector's capability.

The page never places or receives calls. It only displays call-log records the
linked device exposes, labelled "Calls cannot be placed from this dashboard".
Cloud API polls, reaction reads, poll tallies, mark-seen and history-media
downloads return `501` and are replaced with an explanation. WhatsApp Web history
is the recent window the linked device holds, not a complete archive.

Deep links use the exact chat id, for example `#/chats/131355503402%40c.us` or
`#/chats/33247392198739%40lid`.

### Messaging (`#/messaging`)

Lists delivery metadata from `GET /api/v1/ui/deliveries` (optionally filtered by
instance) — timestamp, instance, **masked** recipient (`••••1234`), status badge
and provider message id. Status wording is honest: `accepted` is never shown as
"delivered", and each badge's meaning is defined in the API reference.

"Send test message" composes one message and then requires a second,
explicit confirmation showing the recipient, the instance and the exact body
before `POST /api/v1/messages/send` is called. The recipient may be a phone
number in international format or a full chat id (for example
`131355503402@c.us`), which the WhatsApp Web connector needs to address
LID-based chats. There is no chat history view, no contact list and no
bulk/campaign sending.

### Auto-replies (`#/autoreplies`)

Manage per-instance automatic replies over
`GET`/`POST /api/v1/instances/:id/autoreplies` and
`GET`/`PATCH`/`DELETE /api/v1/instances/:id/autoreplies/:ruleId`. One instance is
selected at a time; the table shows each rule's enabled switch, its match, its
reply body, its cooldown and its recorded activity (`replies`, `matches`,
failures, last match).

The rule dialog composes a match (`exact`, `contains`, `prefix` or `regex`,
optionally case-sensitive) and the reply text — for example matching `/hi` and
replying `Hi, how are you` — with an optional per-chat cooldown. Creating,
editing, enabling/disabling and deleting a rule each go through the API;
deletion is confirmed. The page states plainly that only incoming direct
messages are matched (so a reply can never trigger another reply), that groups
are never auto-replied, and that replies need the instance to be connected.

### Data (`#/data`)

Read-only view of the Data API for one instance, with **Chats**, **Contacts** and
**Live** tabs. It calls `GET /api/v1/instances/:id/chats`,
`GET /api/v1/instances/:id/chats/:chatId`,
`GET /api/v1/instances/:id/chats/:chatId/messages`,
`GET /api/v1/instances/:id/contacts` and `GET /api/v1/instances/:id/messages`,
pages with the API's cursor (`pagination.nextCursor`) and renders the connector's
`limitations` verbatim instead of hiding them.

The tabs are capability-gated on `listChats` / `listContacts` from
`GET /api/v1/instances/:id/capabilities`, so a connector without a capability
gets an explanation rather than an empty table. The Cloud API only exposes
history this gateway retained, and only while retention is enabled; it has no
contact directory. Opening a chat shows direction, type, timestamp, media flag
and text body, and states when older history is unavailable. Nothing on this
page writes to WhatsApp.

The **Live** tab combines both message channels: the SSE stream
(`message.received` / `message.sent`, delivered over the same
`/auth/events` endpoint the Connection page uses) lists messages the instant the
connector reports them, and the **Recorded history** table reads
`GET /api/v1/instances/:id/messages` with a direction filter and explicit
Refresh. Each history row shows whether content was retained (`Retained` vs
`Metadata only`), so an empty body is always explained rather than implied.

### Configuration (`#/config`)

Renders `GET /api/v1/ui/config`: service identity and uptime, connector
availability and credential *status*, security posture (pepper status, whether
development secrets are in use, encryption provider and key count, CORS, IP
allowlist, owner-session settings), reconnection, rate limits, messaging,
events, limits, pagination, storage mode and shutdown timeout.

- Secrets are shown only as **configured / not configured**.
- The resolved `DATA_DIR` path is never returned.
- Everything else is read-only: change it in the environment and restart.

The single editable control is the per-instance retention policy
(`GET`/`PUT /api/v1/instances/:id/retention`), because that is a real,
instance-scoped setting the owner is expected to change.

### Security (`#/security`)

Lists API keys from `GET /api/v1/api-keys` (name, key id, scopes, status, last
used, expiry). It can create keys with a scope picker and presets
(`messages:send`-only service key, or all scopes), rotate a key and revoke a key —
each behind a confirmation dialog.

- A newly created or rotated key is displayed **once**, with a copy button and a
  warning that it cannot be retrieved again.
- Existing plaintext keys are never requested, never displayed and never stored.
- The dialog warns when a key is about to be granted owner scopes.
- **Details** reads `GET /api/v1/api-keys/:keyId` and shows that credential's
  public metadata: key id, tenant, scopes, allowed instances, status and
  timestamps. The key digest is not part of the response.

### Logs (`#/logs`)

Reads `GET /api/v1/ui/audit-events` with filters (category, result, instance,
exact action, date range) and offset pagination, and opens a detail dialog per
event. Audit metadata is already redacted by `AuditService`; the UI additionally
never renders QR payloads, pairing codes, API keys, tokens or message bodies,
because none are present in the payload it receives.

### Settings (`#/settings`)

Theme (light / dark / system), live-refresh cadence, the current owner session
(owner, key id, expiry, scopes) with a sign-out button, dashboard and service
versions, and readiness diagnostics. Preferences are stored in `localStorage`;
the session, CSRF token and any short-lived credential are not.

### Documentation (`#/docs`, `#/docs/:docId`)

Lists every generated document, grouped in reading order and searchable by
title, description, group and file name. A document renders GitHub-flavoured
Markdown with heading anchors; relative `.md` links are rewritten to
`#/docs/<id>` routes (and `#anchor` links stay in the current document), so the
bundled copy is fully navigable.

The Markdown is copied from `docs/` at build time by `scripts/sync-docs.js` and
loaded lazily per document, so the bundle carries a small manifest plus the same
prose the repository has. Editing a document and rebuilding is the only sync
step.

## Dashboard API

The dashboard calls the ordinary `/api/v1/*` routes; cookie authentication is
accepted alongside `X-API-Key`, so no endpoint needed to be duplicated. Only
views that no single existing route provides were added, all under
`/api/v1/ui`, all owner-scoped:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/ui/auth/login` | owner key | Exchange an owner key for a session cookie (rate-limited by the `auth` bucket). |
| `GET /api/v1/ui/auth/session` | session cookie | Confirm the session, return a fresh CSRF token and the owner view. |
| `POST /api/v1/ui/auth/logout` | session cookie + CSRF | Revoke the session. |
| `GET /api/v1/ui/overview` | owner | Aggregated snapshot: service, connections, browsers, primary connection, recent events, recent deliveries, feature flags. |
| `GET /api/v1/ui/config` | owner | Redacted effective configuration. |
| `GET /api/v1/ui/connectors` | owner | Connector capability descriptors (`default` + per connector). |
| `GET /api/v1/ui/deliveries` | owner | Delivery metadata, newest first, optionally per instance. |
| `GET /api/v1/ui/audit-events` | owner | Filtered, paginated audit events. |

"Owner" means `authenticate` plus `requireScopes(auth:manage, keys:manage)`.
`/ui/overview` and `/ui/connectors` derive everything from live service state and
the connector classes themselves, so the dashboard can never claim a capability
the connector does not have. When a connector is disabled it still resolves,
reporting `enabled: false` and the reason, instead of failing the request.

## Security rules the UI follows

1. **No secrets in the browser.** No environment value, encryption key,
   key hash, session file or cookie value is ever sent to or embedded in the
   frontend, and no API key is hardcoded.
2. **No plaintext retrieval.** Keys are shown once, at creation/rotation.
3. **No credential persistence.** QR payloads, pairing codes, the CSRF token and
   the session are memory-only; only presentation preferences are stored.
4. **No invented capability.** Every control is gated on a real capability
   descriptor, and destructive actions are always confirmed.
5. **No hidden state.** Empty, loading, error, disconnected, degraded and
   "not configured" states are all rendered explicitly rather than implied.
6. **Media stays in memory.** Chat media is fetched on demand into an object URL,
   revoked when the bubble unmounts or the chat changes; attachments and voice
   recordings are held only long enough to send and are never written to browser
   storage. No media URL is placed in the page's HTML before the owner opens it.

## Verification status

The dashboard's build, publish, serving, redirects, asset paths, CSP, JSON 404s
and authentication flow were exercised against a running service. The Data API
routes behind `#/data`, the per-instance audit and purge routes, the key-detail
endpoint and the session-revoke route were exercised end-to-end with an owner
session (including the `501 CAPABILITY_NOT_SUPPORTED` path for a connector
without chat history). The rich chat routes, media upload/download, reactions,
poll votes, seen and capability errors were exercised end-to-end against the fake
WhatsApp Web library, and the full suite passes. The `#/chats` page itself was
then exercised in headless Chromium against that fake connector: list and thread
rendering, rich bubbles, media dialog, poll tallies, reactions, conversation
details, text and attachment sends, live SSE updates, deep links and read
receipts all ran without page errors. A real WhatsApp Web session was also linked
and used to verify `status: ready`, chat reads (including a LID-based chat), rich
serialisation (media metadata, quoted and revoked messages), inbound image and
voice-note downloads, and an outbound document download.

Remaining verification gaps are stated rather than implied:

- Rich sends, media upload and browser voice recording have not been exercised
  against a real handset. They are covered by the fake connector and the
  backend suite, not by a live send.
- Cloud API rich sends were not exercised because `META_ACCESS_TOKEN` and
  `META_PHONE_NUMBER_ID` are empty on this host; Cloud-only unsupported paths are
  covered by tests and capability descriptors.

## Related

- [Authentication](./authentication.md) — API keys, scopes, owner sessions.
- [API reference](./api-reference.md) — every endpoint.
- [Security](./security.md) — HTTP hardening, CSP, redaction.
- [Configuration](./configuration.md) — environment variables.
- [Scripts](./scripts.md) — `build:frontend`, `sync:docs`.
