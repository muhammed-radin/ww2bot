# Cloud API webhooks

Inbound messages and message-status events for the official Cloud API connector
arrive at:

```
POST /api/v1/webhooks/whatsapp
GET  /api/v1/webhooks/whatsapp   (verification handshake)
```

These routes are **intentionally not API-key protected**: Meta cannot send one.
They are protected by a shared verify token and an HMAC signature instead.

## Verification handshake (`GET`)

Meta calls this once when you subscribe the webhook.

```
GET /api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
```

- `hub.mode` must be `subscribe`.
- `hub.verify_token` is compared to `META_VERIFY_TOKEN` with a
  **constant-time** comparison.
- `hub.challenge` must match `^[A-Za-z0-9._-]{1,200}$`.
- On success the challenge is echoed as `text/plain` with `200`.
- On failure: `403 Forbidden` (and a warning log without the token).

Requires `META_VERIFY_TOKEN`. When it is unset, verification is not configured
and the handshake is refused with `503 SERVICE_UNAVAILABLE`.

## Delivery (`POST`)

Requirements:

- `META_APP_SECRET` must be set, otherwise `503 SERVICE_UNAVAILABLE`.
- The raw request bytes are captured by the JSON body parser (`verify` hook) and
  checked against `X-Hub-Signature-256`, which must be
  `sha256=<64 hex>`. The comparison is **constant-time**.
- A missing/unverifiable body → `401 UNAUTHORIZED`.
- An invalid signature → `401 UNAUTHORIZED` and a warning log (no payload).
- A per-IP rate limit (generous: `max(default*10, 1000)` per default window) is
  applied.

Only `change.field === "messages"` payloads are acted upon; the payload `object`
must be `whatsapp_business_account` with an `entry` array.

### Response

```json
{
  "success": true,
  "data": { "accepted": true, "messages": 1, "statuses": 0, "duplicates": 0, "unmatched": 0 }
}
```

- `messages` — new inbound messages processed.
- `statuses` — new status events processed.
- `duplicates` — events already seen (Meta retries are harmless).
- `unmatched` — changes whose `phone_number_id` matched no instance.

Meta only needs a fast `200`; the summary is informational.

## Instance matching

For each `messages` change, the gateway resolves the instance by
`value.metadata.phone_number_id`:

1. the instance's `metadata.phoneNumberId`, falling back to
2. the globally configured `META_PHONE_NUMBER_ID`.

No match → the change is counted as `unmatched` and audited
(`webhook.received`, reason `no_matching_instance`), but the request still
succeeds.

## De-duplication

Every provider event id is recorded once per instance in
`DATA_DIR/instances/<id>/webhook-events.jsonl`:

- messages are keyed `msg:<id>`,
- statuses are keyed `status:<id>:<status>`.

A repeated delivery is counted as `duplicates` and not processed again. Markers
live next to the instance, so deleting the instance removes them.

## Retention behaviour

- Message content is stored **only** when retention is enabled for the matching
  instance (`storeInbound` no-ops otherwise — the body is discarded after the
  event is emitted).
- Media is **not downloaded**; only a textual representation is retained where
  one exists (for example a caption).
- The emitted `message.received` event carries **metadata only** — never the
  message body.

### Message bodies extracted

The gateway normalises common Cloud API message types to an optional text body:
`text`, `button`, `interactive` (button/list reply title), `reaction` (emoji),
`location` (null body), and `image`/`video`/`audio`/`document`/`sticker`
(caption). Anything else is recorded as `unknown` with a null body.

## Auditing

- `webhook.received` (failure) for unsupported objects and unmatched instances.
- `webhook.processed` (success) with the summary counts.
- Provider errors attached to a change are logged with the provider code/title
  only — never the payload.

## Local testing

```bash
curl -s "http://localhost:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$META_VERIFY_TOKEN&hub.challenge=1234"
# -> 1234
```

A signed delivery must include a valid `X-Hub-Signature-256` over the exact raw
body bytes; unsigned posts are rejected with `401`.

## Related

- [Connectors → cloud_api](./connectors.md#cloud_api--official-whatsapp-business-platform)
- [Configuration → Cloud API](./configuration.md#official-whatsapp-business-platform-cloud-api)
- [Data retention and privacy](./data-retention.md)
