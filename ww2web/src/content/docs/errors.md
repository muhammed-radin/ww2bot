# Errors

Every error response has one shape, produced centrally by
`src/middleware/errorHandler.js`:

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": { ... } },
  "requestId": "req_..."
}
```

Guarantees:

- A stable machine-readable `code`, a safe `message`, and the `requestId`.
- No stack traces, filesystem paths, SQL, secrets, QR payloads or session data —
  in any response, not just production.
- `details` is included for operational errors: 4xx errors, and curated
  connector/capability errors (5xx) whose messages are authored to be safe and
  actionable (`CAPABILITY_NOT_SUPPORTED`, `CONNECTOR_ERROR`, `PROVIDER_ERROR`,
  `SERVICE_UNAVAILABLE`). Unexpected errors are logged in full server-side and
  reported as a generic `500 INTERNAL_ERROR` with no details.
- `429` responses set `Retry-After`; all rate-limited responses include
  `retryAfterSeconds` in `details`.

## Codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request failed zod validation, or a semantic check (bad cursor shape, inverted date window, ...). |
| `INVALID_CURSOR` | 400 | The pagination cursor signature is invalid or tampered with. |
| `INVALID_JSON` | 400 | The request body is not valid JSON. |
| `PAYLOAD_TOO_LARGE` | 413 | The body exceeds `BODY_LIMIT`. |
| `UNAUTHORIZED` | 401 | Missing/malformed/unknown/revoked/expired API key, or a bad webhook signature. |
| `INVALID_STREAM_TOKEN` | 401 | The SSE stream token is unknown, expired, already used, or for the wrong instance. |
| `FORBIDDEN` | 403 | The key lacks a required scope, or a cross-tenant key creation was attempted. |
| `IP_NOT_ALLOWED` | 403 | The source IP is outside `IP_ALLOWLIST`. |
| `NOT_FOUND` | 404 | The resource does not exist or is not visible to this key (cross-tenant/allowlist → 404, not 403). |
| `CONFLICT` | 409 | A conflicting state (for example forcing a pairing code while one is pending). |
| `INSTANCE_BUSY` | 409 | Another lifecycle operation holds the instance lock. |
| `INSTANCE_NOT_CONNECTED` | 409 | The instance is not connected. |
| `INSTANCE_LIMIT_REACHED` | 409 | `MAX_BROWSER_INSTANCES` is reached. |
| `CONNECTOR_DISABLED` | 409 | The requested connector is disabled (for example the web connector). |
| `RATE_LIMITED` | 429 | A rate limit was exceeded. |
| `CAPABILITY_NOT_SUPPORTED` | 501 | The connector genuinely cannot serve the operation. |
| `CONNECTOR_ERROR` | 502 | The connector failed (browser launch, library error, ...). |
| `PROVIDER_ERROR` | 502 | The upstream provider (Meta Graph API) returned an error or was unreachable. |
| `SERVICE_UNAVAILABLE` | 503 | A required dependency is unavailable (`DATA_DIR` unwritable, webhook signature verification not configured, ...). |
| `INTERNAL_ERROR` | 500 | Unexpected error. Details are never exposed. |

Additional codes defined in the taxonomy but not mapped to a dedicated HTTP
status: `CONNECTOR_UNAVAILABLE`, `INVALID_SIGNATURE`, `RETENTION_DISABLED`,
`NOT_IMPLEMENTED`. They are reserved and returned with the status of the error
class that raises them.

## Body-parser mapping

The error handler also maps Express body-parser failures:

| Condition | Result |
| --- | --- |
| `entity.too.large` | `413 PAYLOAD_TOO_LARGE` |
| `entity.parse.failed` / `SyntaxError` | `400 INVALID_JSON` |
| unsupported encoding/charset | `415 VALIDATION_ERROR` |
| other `status === 400` | `400 VALIDATION_ERROR` |

## Validation details

Validation errors list issues as `{ source, path, message, code }`, where
`source` is `params`, `query` or `body`. They contain paths and messages only —
never the offending value (which could be a credential). For example:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": {
      "issues": [
        { "source": "body", "path": "body.to", "message": "must be a phone number in international format (7-20 digits, no leading zero) or a WhatsApp chat id.", "code": "custom" }
      ]
    }
  },
  "requestId": "req_..."
}
```

## 404 for cross-tenant access

Reading another tenant's resource — or an instance outside a key's
`allowedInstanceIds` — returns `404 NOT_FOUND`, identical to a truly missing
resource. This deliberately prevents key holders from probing for the existence
of foreign resources.

## Unknown endpoints

An unmatched path under `/api` returns `404`:

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "The requested endpoint does not exist." }, "requestId": "req_..." }
```

## Tracing

Every response carries `X-Request-Id`. Include it when reporting an issue; it ties
the response to the server-side log lines.

## Related

- [API reference → response envelope](./api-reference.md#response-envelope)
- [Operations → Troubleshooting](./operations.md#troubleshooting)
