const e=`# Connectors

A connector is the adapter between the gateway's stable API and a specific
WhatsApp transport. Business logic never imports a WhatsApp library directly: it
talks to the interface in \`src/connectors/connector.interface.js\`.

Each connector truthfully advertises its real capabilities through
\`getCapabilities()\`. Any operation it does not genuinely support throws a
structured \`CapabilityNotSupportedError\` → **HTTP 501 \`CAPABILITY_NOT_SUPPORTED\`**
instead of returning invented data.

## The interface

Operations a connector may implement (unsupported ones default to
\`CapabilityNotSupportedError\`):

| Method | Purpose |
| --- | --- |
| \`getCapabilities()\` | Accurate capability descriptor (never aspirational). |
| \`getStatus()\` | \`{ status, details, lastError?, qr? }\`. |
| \`initialize()\` | Start/resume the session. |
| \`requestQrAuth()\` | Begin QR authentication. |
| \`requestPairingCode(phone)\` | Request a device-linking code. |
| \`listChats()\`, \`getChat()\`, \`listMessages()\`, \`listContacts()\` | Read-only data. |
| \`sendMessage({ to, text })\` | Send a text message. |
| \`sendMedia()\`, \`sendPoll()\`, \`sendLocation()\`, \`sendContact()\`, \`sendReaction()\` | Rich sends, each capability-gated. |
| \`downloadMedia()\`, \`getMessageReactions()\`, \`getPollVotes()\` | Linked-device/history reads, each capability-gated. |
| \`markChatSeen()\` | Mark a chat read on the linked device. |
| \`resetForReconnect()\` | Tear down a half-open client before a supervised reconnect. |
| \`disconnect({ logout })\` | Stop the session. |
| \`destroy()\` | Release all resources. |

Capability keys: \`qrAuth\`, \`pairingCode\`, \`listChats\`, \`getChat\`,
\`listMessages\`, \`listContacts\`, \`webhooks\`, \`outboundMessaging\`, \`sendMedia\`,
\`sendVoice\`, \`sendSticker\`, \`sendLocation\`, \`sendContact\`, \`sendPoll\`,
\`sendReaction\`, \`markChatSeen\`, \`messageRecording\`, \`messageReactions\`,
\`pollVotes\`, \`mediaDownload\`, \`maxMediaUploadBytes\`.

## Capability matrix

| Capability | \`cloud_api\` (default) | \`web\` (opt-in, disabled by default) |
| --- | --- | --- |
| Official WhatsApp API | ✅ | ❌ (explicitly not) |
| QR login | ❌ | ✅ |
| Phone-number pairing code | ❌ | ✅ |
| List chats | only recorded data | ✅ (linked device) |
| Get one chat | only with retention | ✅ |
| List messages | only recorded data | ✅ (bounded recent window) |
| List contacts | ❌ | ✅ (may be incomplete) |
| Full historical export | ❌ | ❌ (partial: recent only) |
| Webhooks | ✅ | ❌ |
| Outbound text | ✅ (official) | ✅ (non-official) |
| Outbound media / voice / sticker / document | ✅ (uploaded to Meta first) | ✅ |
| Outbound location / contact | ✅ | ✅ |
| Outbound reaction | ✅ | ✅ |
| Native poll creation | ❌ | ✅ |
| Reaction reads | ❌ | ✅ (linked device) |
| Poll tallies | ❌ | ✅ (linked device, may lag) |
| Mark chat seen | ❌ | ✅ |
| Media download from history | ❌ | ✅ (while the linked device still has it) |
| Place / receive calls | ❌ | ❌ (call-log records only) |
| Message recording | inbound webhooks + gateway sends (retention-gated) | incoming + outgoing (live; retention-gated) |

Discover this from the API itself:

\`\`\`bash
curl -s http://localhost:3000/api/v1/connectors -H "X-API-Key: $KEY"
\`\`\`

---

## \`cloud_api\` — Official WhatsApp Business Platform

The default and the only connector suitable for production.

### What it genuinely does

- Verifies the configured business phone number with a documented Graph API call.
  "Connected" means **Meta accepts these credentials**.
- Receives inbound messages and message-status webhooks the business account is
  subscribed to (signature verification and de-duplication handled by
  \`WebhookService\`).
- Exposes recorded messages read-only (inbound webhook messages and outbound
  sends made through this API), only when the operator explicitly enabled
  retention for the instance.
- Sends outbound text messages through the official \`/messages\` endpoint.
- Sends media (image, video, audio/voice, document, sticker), locations, contact
  cards and reactions through the Graph API. Media is uploaded to Meta first;
  the access token is never exposed.
- Retains safe inbound metadata from webhooks — media MIME type, filename and
  caption, location coordinates, and contact-card names/phone numbers — so the
  conversation view can describe messages whose bytes remain on Meta.

### What it does not do (and never pretends to)

- No WhatsApp Web QR login or phone pairing.
- No full historical chat export.
- No arbitrary contact list.
- No navigation of personal chat history.
- No native poll creation, reaction reads, poll tallies, arbitrary "mark seen",
  or media download from retained history. Those requests return
  \`501 CAPABILITY_NOT_SUPPORTED\`.
- No placing or receiving calls; only call-log records already recorded by the
  gateway or connector can be displayed.

### Capability descriptor highlights

- \`official: true\`
- \`qrAuth: false\`, \`pairingCode: false\`, \`listContacts: false\`,
  \`historicalMessages: false\`
- \`listChats\`/\`getChat\`/\`listMessages\` = \`retentionEnabled\` for the instance
- \`webhooks\` = whether a verify token + app secret are configured
- \`outboundMessaging\` = whether credentials are configured (\`configured\`)
- \`sendMedia\`, \`sendVoice\`, \`sendSticker\`, \`sendLocation\`, \`sendContact\`,
  \`sendReaction\` follow credential configuration; \`sendPoll\`,
  \`messageReactions\`, \`pollVotes\`, \`markChatSeen\` and \`mediaDownload\` are \`false\`
- \`maxMediaUploadBytes\`: \`MEDIA_MAX_BYTES\` (default 16 MB)
- \`messageContentRetention\`: \`enabled\` | \`disabled\`

### Status meaning

\`status: "ready"\` means Meta accepted the access token and phone-number id. When
credentials are missing, \`initialize()\` sets \`error\` and publishes a
**non-recoverable** error (reconnection cannot fix configuration).

### Reads require retention

Chat/message endpoints return \`501 CAPABILITY_NOT_SUPPORTED\` unless retention is
enabled for the instance. When enabled, they read only the inbound webhook
messages this gateway received and retained — outbound and pre-existing history
are unavailable.

### Configuration

\`\`\`dotenv
DEFAULT_CONNECTOR=cloud_api
META_ACCESS_TOKEN=...
META_PHONE_NUMBER_ID=...
META_VERIFY_TOKEN=...      # for webhooks
META_APP_SECRET=...        # for webhook signature verification
META_API_VERSION=v21.0
META_GRAPH_BASE_URL=https://graph.facebook.com
\`\`\`

### The Graph API client

\`CloudApiClient\` implements only the documented endpoints needed:
\`getPhoneNumber()\`, \`sendTextMessage()\`, media upload, and typed message sends
for image, video, audio, document, sticker, location, contact and reaction.
Provider errors are mapped to a safe subset (\`providerCode\`, \`providerType\`, a
truncated \`providerMessage\`) — the raw response and the access token are never
returned to API clients or logged.

---

## \`web\` — Authorised WhatsApp Web (opt-in)

**Disabled by default.** Only constructed when the operator has set
\`ENABLE_WHATSAPP_WEB_CONNECTOR=true\` **and** recorded
\`WHATSAPP_WEB_AUTHORIZATION_REFERENCE\`. It is built on \`whatsapp-web.js\` +
Puppeteer and is explicitly **not an official WhatsApp API**.

### What it genuinely does

- QR login (\`qrAuth\`) and phone-number pairing (\`pairingCode\`).
- Read chats, a single chat, recent messages, and contacts from the linked device.
- Send text, media, voice notes, stickers, documents, locations, contact cards,
  native polls and reactions **as the linked account**.
- Mark a chat read, read reaction lists and poll tallies, and download media
  while the linked device still holds it.

### Honest limits

- Message history is limited to what the linked device can provide; there is no
  complete historical export (\`historicalMessages: "partial: recent messages available on the linked device only"\`).
- A running linked browser can read decrypted message content.
- Only one linked session per instance; cookies and profiles are never shared
  between instances.
- Outbound sends are reported as \`sent\` once the linked device hands the message
  to WhatsApp — **delivery is not independently confirmed**.
- Media downloads ask WhatsApp Web to resolve uncached media and forward the
  declared MIME type to its download manager (current WhatsApp Web builds reject
  uncached media that arrives as \`application/octet-stream\`). Expired or deleted
  media returns \`404 MEDIA_UNAVAILABLE\`; a WhatsApp Web download failure returns
  \`502 CONNECTOR_ERROR\`.
- Poll tallies and reaction lists are linked-device reads and may be unavailable
  or lag behind the phone.
- Calls cannot be placed or received. Only \`call_log\` records already present on
  the linked device are displayed.
- No webhooks.

### Enabling it

\`\`\`dotenv
ENABLE_WHATSAPP_WEB_CONNECTOR=true
WHATSAPP_WEB_AUTHORIZATION_REFERENCE=CONTRACT-2026-00042
WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted
\`\`\`

Enabling without the authorization reference is a **fatal** configuration error.

### Session strategies

| Strategy | Storage | Encryption at rest |
| --- | --- | --- |
| \`local\` (default) | \`whatsapp-web.js\` \`LocalAuth\` Chromium profile directory | **Not** encrypted by this service — relies on the hosting volume |
| \`remote_encrypted\` | \`RemoteAuth\` archive encrypted via \`EncryptedSessionStore\` | AES-256-GCM before it is written; only ciphertext on disk |

In production, \`local\` produces a warning. The gateway **never claims** the live
browser profile is encrypted just because JSON files are.

Per-instance session directory: \`DATA_DIR/instances/<id>/session\` (\`0700\`).
Encrypted archive: \`session-archive.enc\` + \`session-archive.meta.json\`.

### Pairing-code caveat (whatsapp-web.js v1.34.x)

\`whatsapp-web.js\` only honours the constructor \`pairWithPhoneNumber\` option.
Calling \`requestPairingCode()\` on a client built for QR throws in this version.
The connector therefore **rebuilds the client in pairing mode** instead of
calling it from the \`qr\` handler. A still-valid code is reused unless \`force\` is
set.

### Chat and message reads on current WhatsApp Web builds

\`whatsapp-web.js\` 1.34.7 builds each chat through \`getChatModel()\`, which runs
\`chat.serialize()\`. Current WhatsApp Web builds renamed an internal message-key
field (\`_serialized\` → \`$1\`) and changed group-metadata handling, which makes
that call throw for some chats. As a result the library's \`getChats()\` and
\`getChatById()\` reject as a whole with an opaque single-letter error (\`r\`), even
though the linked session is healthy.

The connector does **not** rely on those methods for reads. It reads the same
page store the library reads, one chat/message at a time and only primitive
fields, so a chat that cannot be serialised is skipped instead of failing the
whole request. If the page is unavailable the connector falls back to the
library API. This is a compatibility workaround for a library bug, not a
platform restriction being circumvented; it is removed once the upstream fix
lands in a released \`whatsapp-web.js\`.

### Sending to a chat id

A WhatsApp Web send must address the exact chat. Modern WhatsApp uses LID-based
ids (\`...@lid\`) for direct chats as well as phone-number ids (\`...@c.us\`), so
the connector sends to whatever \`to\` it is given: a bare phone number is treated
as \`<number>@c.us\`, and a full chat id is passed through unchanged. Rewriting a
LID to a phone number would address the wrong chat.

### Photo and video preparation

Current WhatsApp Web builds return a \`MediaData\` model from their media
preparation pipeline. That model carries internal \`__x_*\` fields; when
\`whatsapp-web.js\` spreads it into the outgoing message, \`__x_id\` can shadow the
real message key and sender validation fails before the message reaches
WhatsApp. The connector installs a small page-side guard before the first media
send that removes those internal fields. The guard only touches media messages;
text sends are unchanged.

The dashboard still re-encodes selected photos to a bounded JPEG (max 2048 px,
targeting 4 MB) and flattens transparency onto white. Animated GIFs, SVGs and
formats the browser cannot decode are offered as documents.

The connector has a second safety net: if image/video preparation fails with a
recognised pre-send media error, it retries the same bytes once as a document.
The API response then reports \`type: "document"\`, \`fallback: "document"\` and a
\`warning\`, and the dashboard shows that warning. It never retries a network or
post-send failure, and it never converts voice notes, stickers or GIFs into
silent documents.

### Rich sends and reads

The dashboard's \`#/chats\` page uses the per-chat routes in
[Chat actions](./api-reference.md#chat-actions). The Web connector serialises
media messages with their observed \`mimetype\`, filename, size and voice/sticker
flags; it does **not** fetch media until the operator opens it. Voice notes are
sent as \`ptt\`/audio using the uploaded bytes, so the browser recording container
must be one WhatsApp accepts (WebM/Ogg Opus usually works; a rejection is
reported). Poll votes and reactions are read from the linked page store; they are
not invented when the page cannot supply them.

### Browser security

\`BrowserManager\` enforces:

- admission control (\`MAX_BROWSER_INSTANCES\`),
- **one browser per instance** (a second init is rejected, not launched),
- deterministic teardown on disconnect, crash and shutdown,
- Chromium's **sandbox enabled by default** — it is only disabled when the
  operator explicitly sets \`WHATSAPP_WEB_NO_SANDBOX=true\` on hosts that block
  unprivileged user namespaces, and **no remote-debugging port** is set.

Launch flags are conservative (\`--disable-dev-shm-usage\`, \`--disable-extensions\`,
\`--no-first-run\`, \`--disable-background-networking\`, \`--disable-sync\`, ...). There
are **no stealth/anti-detection plugins** and no attempts to defeat platform
restrictions.

If Chromium fails with \`No usable sandbox!\` on Ubuntu 23.10+ or inside a
container, the secure fixes are to enable the SUID sandbox or grant the required
container capability. \`WHATSAPP_WEB_NO_SANDBOX=true\` is a development-only
fallback; it weakens browser isolation and should not be the default in
production.

### Chat id validation

Chat ids match \`^[A-Za-z0-9@._-]{5,80}$\`; an invalid id is rejected before
anything is looked up.

---

## Discovery and truthfulness

\`describeSupportedEndpoints(capabilities)\` maps capabilities to the endpoints a
connector can genuinely serve:

\`\`\`
GET  /api/v1/instances/:instanceId/status                       → always true
POST /api/v1/instances/:instanceId/connect/qr                   → qrAuth
POST /api/v1/instances/:instanceId/connect/pairing-code         → pairingCode
GET  /api/v1/instances/:instanceId/auth/events                  → always true
GET  /api/v1/instances/:instanceId/chats                        → listChats
GET  /api/v1/instances/:instanceId/chats/:chatId                → getChat
GET  /api/v1/instances/:instanceId/chats/:chatId/messages       → listMessages
GET  /api/v1/instances/:instanceId/contacts                     → listContacts
POST /api/v1/messages/send                                      → outboundMessaging
POST /api/v1/instances/:instanceId/chats/:chatId/messages       → outboundMessaging
POST /api/v1/instances/:instanceId/chats/:chatId/messages/media → sendMedia
POST /api/v1/instances/:instanceId/chats/:chatId/messages/poll  → sendPoll
POST /api/v1/instances/:instanceId/chats/:chatId/messages/location → sendLocation
POST /api/v1/instances/:instanceId/chats/:chatId/messages/contact  → sendContact
POST /api/v1/instances/:instanceId/chats/:chatId/messages/:messageId/reaction → sendReaction
GET  /api/v1/instances/:instanceId/chats/:chatId/messages/:messageId/media → mediaDownload
GET  /api/v1/instances/:instanceId/chats/:chatId/messages/:messageId/reactions → messageReactions
GET  /api/v1/instances/:instanceId/chats/:chatId/messages/:messageId/poll-votes → pollVotes
POST /api/v1/instances/:instanceId/chats/:chatId/seen           → markChatSeen
\`\`\`

## Production guidance

Use the **official WhatsApp Business Platform** for production business
messaging. The web connector is a narrowly-scoped, authorisation-gated option and
carries the linked account's own risk.

## Related

- [Connection lifecycle](./connection-lifecycle.md)
- [Outbound messaging](./outbound-messaging.md)
- [Configuration → Connectors](./configuration.md#connectors)
`;export{e as default};
