const e=`# Data retention and privacy

The gateway collects only what it needs and keeps message content off disk unless
the operator explicitly opts in.

## Principles

- **No automatic chat enumeration.** Chats are read from the connected device or
  retained webhook data only on request; nothing is scraped in the background.
- **Message bodies never appear in logs.** Callers do not log them, and a
  redaction list is the safety net.
- **Opt-in retention.** \`RETAIN_MESSAGE_CONTENT=false\` globally, and
  \`retentionEnabled\` per instance.
- **Minimum delivery metadata.** Only what is needed to troubleshoot and to make
  retries idempotent.
- **Controlled deletion.** Per-instance purge and full teardown are explicit
  endpoints.
- **Separated concerns.** The audit trail is separate from connection metadata.

## Message retention

Message content is written to \`messages.jsonl\` **only** when the instance has
retention enabled with a positive window.

- \`RETAIN_MESSAGE_CONTENT\` (global default, \`false\`).
- \`retentionEnabled\` (per instance).
- \`DEFAULT_RETENTION_DAYS\` (per-instance default), bounded by \`MAX_RETENTION_DAYS\`.
- When retention is disabled, \`storeMessages\` no-ops and the body is discarded
  after the event is emitted.

### From the Cloud API

Inbound messages received via webhooks, and messages this gateway sends through
the Cloud API, are retained. Pre-existing history is not available. Media is not
downloaded; only a textual representation (body or caption) is kept where one
exists.

### From WhatsApp Web

Incoming messages (the library's \`message\` event) and outgoing messages
(\`message_create\`, including messages typed on the linked phone and sends made
through this API) are recorded. With retention disabled the bodies are kept only
in a bounded in-memory buffer for the life of the session and never written to
disk; enabling retention persists them like Cloud API messages.

Either way, \`GET /api/v1/instances/:instanceId/messages\` returns the recorded
history (both directions) with a \`contentRetained\` flag per item, and the live
\`message.received\` / \`message.sent\` events carry the same information over SSE.

### Encryption at rest

Retained message \`body\` values are encrypted with AES-256-GCM (AAD binds the
ciphertext to \`msg:<instanceId>:<id>\`), so a ciphertext cannot be moved between
instances. \`chatId\` is kept plaintext so list/read queries work.

## Delivery metadata

| Setting | Default | Effect |
| --- | --- | --- |
| \`OUTBOUND_MESSAGING_ENABLED\` | \`true\` | Whether outbound sending (and its metadata) is active. |
| \`IDEMPOTENCY_TTL_MS\` | \`86400000\` | How long an idempotency key suppresses duplicates. |
| \`DELIVERY_METADATA_RETENTION_DAYS\` | \`7\` | How long delivery metadata is kept (\`0\` = none). |

Stored: idempotency digest, outcome, provider message id, **encrypted**
recipient, timestamps, key id. Never the message body. Deleting an instance
removes its delivery metadata.

## Audit trail

Append-only events at \`audit/events.jsonl\`, retained for
\`AUDIT_EVENTS_RETENTION_DAYS\` (default 90).

Audit records answer "who did what, to which resource, with what result". They
are deliberately narrow and pass through a recursive redactor as a second line
of defence:

- keys matching \`api[-_]?key|secret|password|token|authorization|cookie|session|qr|pairing|otp|credential|private[-_]?key\` are \`[REDACTED]\`;
- keys matching \`body|text|message|messages|content|payload|raw|media\` are
  \`[REDACTED]\`;
- strings are truncated (200 chars), arrays capped (50 items), depth capped (5).

Actions recorded include:

\`auth.missing_api_key\`, \`auth.success\`, \`api_key.created\`,
\`api_key.verification_failed\`, \`api_key.rotated\`, \`api_key.revoked\`,
\`instance.created\`, \`instance.connect_requested\`, \`instance.connected\`,
\`instance.reconnected\`, \`instance.reconnect_failed\`, \`instance.disconnected\`,
\`instance.logged_out\`, \`instance.session_revoked\`, \`instance.retention_updated\`,
\`instance.deleted\`, \`retention.purged\`, \`session.persisted\`, \`session.destroyed\`,
\`message.send\`, \`webhook.received\`, \`webhook.processed\`.

The audit trail never contains credentials, QR payloads, pairing codes or message
bodies.

## Purging

### On demand (per instance)

\`\`\`
POST /api/v1/instances/:instanceId/data/purge     # scope: auth:manage
\`\`\`

Deletes retained messages, webhook de-duplication markers and delivery metadata
for the instance, and writes a \`retention.purged\` audit event.

### Automatic (maintenance)

\`\`\`
npm run session:purge
\`\`\`

\`RetentionService.purgeExpiredForAllInstances()\`:

- drops messages older than each instance's window,
- prunes webhook markers older than \`DEFAULT_RETENTION_DAYS\`,
- prunes old audit events (\`AUDIT_EVENTS_RETENTION_DAYS\`),
- prunes delivery metadata past \`DELIVERY_METADATA_RETENTION_DAYS\`.

Intended to run from cron or a Kubernetes CronJob.

### Full teardown

\`\`\`
DELETE /api/v1/instances/:instanceId             # scope: auth:manage
\`\`\`

Removes the connector, purges retained data, destroys session material, deletes
the connection state and the instance record.

## Logout vs. session deletion

These are deliberately distinct and never conflated:

| Action | Effect on stored session material |
| --- | --- |
| \`POST .../disconnect { logout: false }\` (default) | **Kept** so the instance can reconnect. |
| \`POST .../disconnect { logout: true }\` | Removed. |
| \`DELETE .../session\` | Removed (without deleting the instance). |
| \`DELETE .../instance\` | Removed (instance deleted). |

## Privacy summary

| Data | Default treatment |
| --- | --- |
| Message bodies | Not stored unless retention is explicitly enabled; encrypted when stored. |
| Media | Never downloaded. |
| Phone numbers | Redacted from logs; delivery recipients stored encrypted. |
| API keys | Digests only; plaintext shown once. |
| QR / pairing codes | Never logged or persisted; short-lived. |
| Cookies / session material | Never returned via the API; profile on disk (encrypted if \`remote_encrypted\`). |
| Chats/contacts | Read on demand only; never enumerated automatically. |
| Audit events | Redacted, retained 90 days by default. |

## Related

- [Storage](./storage.md)
- [Security](./security.md)
- [Outbound messaging](./outbound-messaging.md)
`;export{e as default};
