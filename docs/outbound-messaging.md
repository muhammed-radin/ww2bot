# Outbound messaging

The RazorBills backend sends messages through a single endpoint with the narrow
`messages:send` scope.

```
POST /api/v1/messages/send
```

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
- [Configuration → Outbound messaging](./configuration.md#outbound-messaging)
- [Data retention and privacy](./data-retention.md)
