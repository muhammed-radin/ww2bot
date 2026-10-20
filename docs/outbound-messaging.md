# Outbound messaging

The RazorBills backend exposes one stable text endpoint with the narrow
`messages:send` scope, plus per-chat rich-message endpoints used by the owner
dashboard.

```
POST /api/v1/messages/send
```

The public endpoint stays intentionally small: it sends `text` only. Rich sends
(media, polls, locations, contacts and reactions) live under
`/instances/:instanceId/chats/:chatId/...` and still run through the same
`OutboundService` for validation, capability checks, idempotency, recipient rate
limits, audit records and retention.

## Request

Body:

```json
{
  "instanceId": "ins_...",
  "to": "15551234567",
  "type": "text",
  "text": "Your invoice is ready",
  "idempotencyKey": "order-42"
}
```

| Field | Rules |
| --- | --- |
| `instanceId` | Required; `^ins_[a-f0-9]{32}$`; must be an instance the key is entitled to. |
| `to` | Required. Either a phone number in international format (a leading `+` is trimmed; digits only, `^[1-9]\d{6,19}$`, 7–20 digits, no leading zero) **or** a full WhatsApp chat id such as `131355503402@c.us` or a LID-based `33247392198739@lid`. The WhatsApp Web connector needs the exact id; the Cloud API reduces it to the phone number. |
| `type` | Optional; must be `"text"` when present. Only text is supported. |
| `text` | Required; 1–4096 characters, non-blank. |
| `idempotencyKey` | Optional; ≤ 200 characters. May also be supplied as the `Idempotency-Key` header (**header wins**). |

## Response

```json
{
  "success": true,
  "data": {
    "instanceId": "ins_...",
    "to": "15551234567",
    "status": "accepted",
    "providerMessageId": "wamid...",
    "acceptedAt": "2026-01-01T00:00:00.000Z",
    "idempotent": false,
    "connector": "cloud_api",
    "note": "Meta accepted the send request. Delivery to the handset is not confirmed."
  }
}
```

- When the request is a replay of an idempotency key still within
  `IDEMPOTENCY_TTL_MS`, the original result is returned with `"idempotent": true`
  and **nothing is sent**.
- When a replay is found, `providerMessageId` and `acceptedAt` are those of the
  original delivery.

## Rich chat actions

Every rich action requires `messages:send`, targets an exact chat id (a phone
number is not accepted here), and uses the same audit, delivery-metadata and
per-recipient rate-limit path as `/messages/send`. Reads used by the chat page
(reaction lists, poll tallies, media bytes) use `data:read` instead.

| Action | Endpoint | Shape |
| --- | --- | --- |
| Text / reply | `POST /instances/:instanceId/chats/:chatId/messages` | JSON `{ text, replyToMessageId?, idempotencyKey? }` |
| Media | `POST /instances/:instanceId/chats/:chatId/messages/media` | Raw `application/octet-stream` body + headers/query below |
| Poll | `POST /instances/:instanceId/chats/:chatId/messages/poll` | JSON `{ question, options, allowMultipleAnswers?, replyToMessageId? }` |
| Location | `POST /instances/:instanceId/chats/:chatId/messages/location` | JSON `{ latitude, longitude, name?, address?, url?, replyToMessageId? }` |
| Contact | `POST /instances/:instanceId/chats/:chatId/messages/contact` | JSON `{ contactId }` (Web) **or** `{ contact: { name?, phone, organization? } }` (Cloud) |
| Reaction | `POST /instances/:instanceId/chats/:chatId/messages/:messageId/reaction` | JSON `{ reaction }` (`""` removes the reaction where supported) |
| Mark seen | `POST /instances/:instanceId/chats/:chatId/seen` | Empty JSON body |
| Media download | `GET /instances/:instanceId/chats/:chatId/messages/:messageId/media` | Raw bytes, `data:read` |
| Reaction read | `GET /instances/:instanceId/chats/:chatId/messages/:messageId/reactions` | JSON, `data:read` |
| Poll tallies | `GET /instances/:instanceId/chats/:chatId/messages/:messageId/poll-votes` | JSON, `data:read` |

### Media upload protocol

The JSON limit stays at 100 kb; media does **not** go through the JSON parser.

```http
POST /api/v1/instances/ins_.../chats/131355503402@c.us/messages/media?voice=1
Content-Type: application/octet-stream
X-Media-Mimetype: audio/ogg; codecs=opus
X-Media-Filename: dmFsaWQtbm90ZS5vZ2c
X-Media-Caption: U2VudCBmcm9tIHRoZSBkYXNoYm9hcmQ=
Idempotency-Key: note-42
```

- The request body is the file bytes.
- `X-Media-Mimetype` is required and must be a valid MIME type.
- `X-Media-Filename` and `X-Media-Caption` are **base64url-encoded UTF-8**
  metadata headers. Filenames are reduced to their last path segment and control
  characters are stripped; captions are limited to 1024 characters.
- Query flags: `voice`, `document`, `sticker`, `gif`, `viewOnce` (`true|false|1|0`),
  plus `replyToMessageId` and `idempotencyKey`. The Web connector forwards the
  hints; the Cloud API maps `voice` to `audio.voice` and ignores GIF/view-once.
- The decoded bytes are size-checked against `MEDIA_MAX_BYTES` (default 16 MB).
  The connector decides whether the bytes are acceptable; WhatsApp may reject a
  container or codec and that error is returned, not hidden.
- `voice=1` sends a WhatsApp voice note. The browser records Opus in WebM/Ogg;
  send a format WhatsApp accepts when using the API directly.

### Capability matrix for rich actions

| Action | `web` (linked device) | `cloud_api` |
| --- | --- | --- |
| Text, image, video, audio, document, sticker | ✅ | ✅ when credentials are configured |
| Voice note | ✅ | ✅ when credentials are configured |
| Location | ✅ | ✅ |
| Contact | ✅ by exact contact id | ✅ by name + phone |
| Native poll | ✅ | ❌ `501 CAPABILITY_NOT_SUPPORTED` |
| Reaction send | ✅ | ✅ |
| Reaction read | ✅ | ❌ |
| Poll tallies | ✅ (linked-device read, may lag) | ❌ |
| Mark chat seen | ✅ | ❌ |
| Media download from history | ✅ (while the linked device still has it) | ❌ |

Calls are never placed by either connector. `web` can only read call-log records
that the linked device already contains.

## Honest statuses

`DeliveryStatus` = `accepted` | `sent` | `failed` | `unknown`.

| Status | Connector | Meaning |
| --- | --- | --- |
| `accepted` | `cloud_api` | Meta accepted the send request. **Not** proof of delivery to the handset. Final delivery is confirmed later by Cloud API webhook status events. |
| `sent` | `web` | The linked device handed the message to WhatsApp. Not an independent delivery confirmation. |
| `failed` | any | The connector call raised. |
| `unknown` | any | The connector could not report a recognised status. |

The gateway **never auto-retries an ambiguous send**, because retrying could
duplicate a message. A failed send raises the underlying connector error (for
example `502 CONNECTOR_ERROR` / `502 PROVIDER_ERROR`) after recording `failed`
delivery metadata and an audit event.

## Idempotency

- Provide `idempotencyKey` in the body or `Idempotency-Key` header.
- The raw key is **never stored**: it is HMAC-SHA256 hashed (keyed by a digest of
  `API_KEY_PEPPER`) together with the instance id.
- A duplicate within `IDEMPOTENCY_TTL_MS` (default 24h) returns the original
  result and does not send again.
- `DELIVERY_METADATA_RETENTION_DAYS=0` disables delivery metadata and therefore
  idempotency (a warning is emitted at startup).

## Rate limits

- **Per key + per IP** (`RATE_LIMIT_SEND_*`, default 120/min).
- **Per recipient** (`RATE_LIMIT_RECIPIENT_*`, default 20/min), keyed by an HMAC
  of the recipient so the phone number is not used as a raw bucket key.

Exceeding a limit returns `429 RATE_LIMITED` with `Retry-After` and a `details`
object including `scope`, `limit`, `windowMs` and `retryAfterSeconds`.

## Minimum delivery metadata

Only the minimum needed to troubleshoot is stored, in
`DATA_DIR/instances/<id>/deliveries.jsonl`:

- the idempotency digest,
- the outcome (`status`, `errorCode`),
- the provider message id when available,
- the **encrypted** recipient,
- timestamps and the key id that sent it.

Retention is bounded by `DELIVERY_METADATA_RETENTION_DAYS`. Deleting the
instance removes its delivery metadata.

## Configuration gates

- `OUTBOUND_MESSAGING_ENABLED=false` disables the endpoint
  (`501 CAPABILITY_NOT_SUPPORTED`).
- The connector must advertise `outboundMessaging` (both do when configured);
  otherwise `501`.
- Cloud API sends require `META_ACCESS_TOKEN` + `META_PHONE_NUMBER_ID`.
- Web sends require a live, `ready` session.

## Acceptable-use constraints

- **No scraping, no bulk unsolicited messaging, no contact collection.**
- Validate recipients and content; respect per-recipient limits.
- Use the **official WhatsApp Business Platform** for production business
  messaging.

## Related

- [API reference → Outbound](./api-reference.md#outbound--scope-messagessend)
- [API reference → Chat actions](./api-reference.md#chat-actions)
- [Configuration → Outbound messaging](./configuration.md#outbound-messaging)
- [Data retention and privacy](./data-retention.md)
