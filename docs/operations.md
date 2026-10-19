# Operations

A runbook for running, maintaining and troubleshooting the service.

## Running

```bash
npm start              # production start
npm run dev            # node --watch (development)
```

Startup logging reports the port, host, repository mode (`filesystem`), data
directory, whether the web connector is enabled, the default connector, and the
startup-recovery summary.

### Signals

The server handles `SIGTERM` and `SIGINT` gracefully:

1. stop accepting connections,
2. let in-flight requests finish (then force-close SSE streams after ~2s),
3. run `container.shutdown()` (supervisors, browsers, event bus, temp sweep),
4. exit `0`.

A hard timeout (`SHUTDOWN_TIMEOUT_MS`) forces exit `1` if shutdown stalls. An
uncaught exception is logged as `fatal` and triggers the same shutdown.

`tini` is PID 1 in the container so signals are forwarded correctly.

## Monitoring

### Health endpoints

```bash
curl -s http://localhost:3000/health/live    # process liveness
curl -s http://localhost:3000/health/ready   # storage writable + component status
```

`/health/ready` returns `503` when `DATA_DIR` is not writable.

### Logs

Structured JSON (pino) with credential/QR/pairing redaction. The request logger
is disabled under `NODE_ENV=test`; `/health/live` is excluded from access logs.

Useful fields: `level`, `time`, `service`, `env`, `req.id`, `err`,
`instanceId`, `errorCode`.

Set `LOG_LEVEL=debug` to see connection-event envelopes (never payloads) and
`LOG_LEVEL=trace` for maximum detail. Use `warn`/`error` in steady state.

### Rate-limit headers

Every response from a limited route carries `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on `429`.

## Routine maintenance

### Enforce retention

Run on a schedule (cron / Kubernetes CronJob):

```bash
npm run session:purge
```

Prints a JSON summary: `{ instances, messagesDeleted, webhookEventsDeleted,
auditEventsDeleted, deliveriesDeleted }`.

### Rotate API keys

```bash
npm run key:rotate -- --key-id <keyId> [--grace-period-ms 300000]
# or over HTTP with an owner key:
curl -s -X POST http://localhost:3000/api/v1/api-keys/<keyId>/rotate \
  -H "X-API-Key: $OWNER_KEY"
```

A non-zero grace period keeps the old secret valid for that long (zero-downtime
rollouts).

### Rotate the encryption keyring

1. Add a new key to the ring (keep the old key).
2. Set `ENCRYPTION_KEY_ID` to the new id.
3. Restart. New writes use the new key; old ciphertext still decrypts.

### Rotate the API key pepper

Changing `API_KEY_PEPPER` invalidates **every** existing key. Only do this with a
planned re-issue of all keys.

## Backup and restore

### Backup

- Back up the whole `DATA_DIR` (keys, instances, sessions, deliveries, audit).
- Back up the **encryption keyring** separately, in your secret manager. A backup
  without the keyring cannot be restored.

```bash
# Example: consistent-ish snapshot while the service is stopped
systemctl stop razorbills-whatsapp
tar -czf gateway-data-$(date +%F).tgz -C /var/lib/razorbills-whatsapp data
systemctl start razorbills-whatsapp
```

For live backups, prefer a filesystem/volume snapshot. Writes are atomic, so a
snapshot captures either the old or the new version of each file.

### Restore

1. Stop the service.
2. Restore the directory to the same path.
3. Start the service. Previously-live `cloud_api` instances reconnect
   automatically (if `AUTO_RECONNECT_ON_STARTUP=true`); web instances require the
   owner to re-scan a QR code.

## Troubleshooting

| Symptom | Diagnosis / fix |
| --- | --- |
| Startup prints `Invalid configuration: ...` | A required env var is missing/malformed. The message lists each problem and contains no secrets. |
| Startup prints `DATA_DIR ... is not usable` | `DATA_DIR` is missing or not writable by the process user. Create it `0700`, owned by the process user. |
| Service starts but warns about an ephemeral pepper/keyring | Set `API_KEY_PEPPER` and `ENCRYPTION_KEYS` (production requires them). |
| `401 UNAUTHORIZED` on everything | Missing/incorrect `X-API-Key` header. Keys are header-only. |
| `403 FORBIDDEN` | The key lacks the required scope (`details.missingScopes`) or a cross-tenant key creation was attempted. |
| `404 NOT_FOUND` for a known instance | The key's tenant or `allowedInstanceIds` does not cover it (deliberately 404, not 403). |
| `IP_NOT_ALLOWED` | `IP_ALLOWLIST` is set and the source IP is not in it. |
| `409 INSTANCE_BUSY` | A lifecycle operation holds the instance lock. Retry shortly. |
| `409 INSTANCE_LIMIT_REACHED` | `MAX_BROWSER_INSTANCES` reached. Disconnect unused web instances or raise the limit. |
| `501 CAPABILITY_NOT_SUPPORTED` | The connector genuinely cannot serve the operation (for example cloud_api QR, or reads without retention). |
| `502 CONNECTOR_ERROR` / `502 PROVIDER_ERROR` | Connector/browser/library or Meta Graph API failure. Check the provider error fields and logs. |
| Cloud API instance stuck in `ERROR` | Credentials are wrong/rejected (non-recoverable). Fix `META_*` and reconnect. |
| Web instance stuck in `ERROR` | Reconnection budget exhausted, or a non-recoverable auth failure. Re-initiate with the owner key. |
| Webhooks returning `401` | `X-Hub-Signature-256` missing/invalid, or `META_APP_SECRET` unset. |
| Webhooks returning `503` | `META_APP_SECRET`/`META_VERIFY_TOKEN` not configured. |
| SSE stream closes immediately | Token expired/used (`INVALID_STREAM_TOKEN`), wrong instance, or >10 concurrent streams (`429`). Issue a fresh token. |
| A `data/*.corrupt-<ts>` file appeared | A file failed to parse/schema-check and was quarantined; the service rebuilt from the fallback. Inspect and remove when satisfied. |
| `EADDRINUSE` at startup | Another process holds the port, or a second instance is running against the same host/port. |

### Inspecting state

All state is plain files under `DATA_DIR` (see [Storage](./storage.md)):

```bash
cat data/instances/<id>/connection.json
cat data/instances/<id>/instance.json
tail -n 20 data/audit/events.jsonl
```

### Checking lock leftovers

Stale locks are reclaimed at startup by verifying the owner pid is gone. If you
suspect a stuck lock, inspect `data/locks/*.lock` — each contains a `pid`. Do not
delete a lock for a live process.

### Restarting safely

Restarting is safe: connection state and sessions persist; temp files and stale
locks are swept; `cloud_api` instances reconnect automatically. Web instances
require a re-scan so a restart never generates an unsolicited QR code.

## Capacity and limits

- One process per `DATA_DIR`.
- `MAX_BROWSER_INSTANCES` bounds concurrent Chromium instances.
- Per-instance locks serialise lifecycle operations; per-file mutexes serialise
  writes.
- Rate limits are in-memory and reset on restart.

## Related

- [Deployment](./deployment.md)
- [Storage](./storage.md)
- [Errors](./errors.md)
- [Security](./security.md)
