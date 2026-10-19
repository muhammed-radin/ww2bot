# Storage

There is no database and no Redis. Everything the service persists lives under
`DATA_DIR` (default `./data`).

## Layout

```
data/
  config/
    service.json            # non-secret service metadata (schema version, ...)
  api-keys/
    keys.json               # key digests only (pepper-keyed HMAC) + metadata
  instances/
    ins_<32 hex>/
      instance.json         # instance metadata (connector, retention, ...)
      connection.json       # persisted connection state machine
      session/              # browser profile (local strategy) — 0700
      session-archive.enc   # encrypted session archive (remote_encrypted)
      session-archive.meta.json
      messages.jsonl        # retained messages, incoming + outgoing (bodies encrypted)
      autoreplies.json      # automatic-reply rules (literal match + reply text)
      webhook-events.jsonl  # web de-duplication ledger
      deliveries.jsonl      # outbound idempotency + minimal delivery metadata
  audit/
    events.jsonl            # append-only security/operational audit trail
  locks/
    <hash>.lock             # per-instance operation locks (no secrets)
  tmp/                      # transient scratch; swept on startup and shutdown
```

### What each file contains

| File | Contents | Sensitive? |
| --- | --- | --- |
| `config/service.json` | Schema version, creation timestamp, a description string. | No |
| `api-keys/keys.json` | Key ids, pepper-keyed HMAC digests, scopes, tenant, allowlist, timestamps. | Digests only; no plaintext |
| `instances/<id>/instance.json` | Connector, display name, status, retention, sanitised metadata, timestamps. | Low |
| `instances/<id>/connection.json` | State machine: state, attempt, timestamps, redacted last error. | No |
| `instances/<id>/session/` | Chromium profile (local strategy). | **Yes** — not encrypted by this service |
| `instances/<id>/session-archive.enc` | AES-256-GCM ciphertext of the session archive. | Encrypted |
| `instances/<id>/messages.jsonl` | Retained messages (incoming + outgoing); `body` encrypted, `chatId` plaintext. | Partially encrypted |
| `instances/<id>/autoreplies.json` | Automatic-reply rules (literal match + reply text); no credentials, no message content. | Low |
| `instances/<id>/webhook-events.jsonl` | Provider event ids for de-duplication. | Low |
| `instances/<id>/deliveries.jsonl` | Idempotency digest, outcome, encrypted recipient, provider id. | Partially encrypted |
| `audit/events.jsonl` | Who did what, to which resource, with what result. | Redacted |
| `locks/<hash>.lock` | Owner pid/token for lock recovery. | No secrets |

## Storage guarantees

### Atomic writes

Data is written to a **uniquely named** temp file (`.<name>-<pid>-<random>`) in
the same directory, flushed with `fsync`, then renamed over the target. The
directory is `fsync`'d where supported. A reader never observes a half-written
file; an interrupted write leaves either the old file or the new one — never a
corrupt mixture. Temp files are swept on startup and on graceful shutdown.

### Serialised updates

A keyed in-process **mutex** serialises read-modify-write cycles for the same
file, so two concurrent requests cannot lose an update. JSONL files support the
same via `updateJsonl` — an append and a maintenance purge take the same mutex and
can never race.

### Corruption tolerance

- A missing file is not an error: the documented fallback is returned.
- A file that is empty, unparseable, or fails its schema check is **quarantined**
  (renamed to `<file>.corrupt-<timestamp>`) and reported; the caller gets the
  fallback and can safely rebuild it.
- In a JSONL file, individual unparseable lines are skipped and counted; the rest
  is returned.
- Transient read errors (`EACCES`, `EIO`, ...) are logged and treated as the
  fallback, never destructively.
- A file larger than 64 MiB hard limit is quarantined rather than read.

### Restrictive permissions

- Directories are created `0700`, files `0600`.
- `DATA_DIR` itself is `chmod 0700` on init (best effort).

### Validated paths

Every path is derived from an already-validated internal identifier and asserted
to stay inside `DATA_DIR`:

- identifiers must match `^[A-Za-z0-9_.:@-]{1,128}$` and never be `.` or `..`;
- `under(...)` refuses any joined path outside the data root.

A crafted identifier cannot escape the storage directory.

## Locks

`src/storage/fileLock.js` implements per-instance operation locks.

- The **authoritative** guard is an in-memory map — this is a single-process
  deployment.
- A small lock file (`data/locks/<sha256-prefix>.lock`) records `{ key, token,
  pid, op, acquiredAt }` so a **restart** can reclaim locks left by a crashed
  process.
- A stale lock is reclaimed **only after verifying the owner is gone**:
  - for another pid: `process.kill(pid, 0)`; `EPERM` counts as alive;
  - for this pid: the in-memory owner must no longer hold the exact token.
- A lock is **never** deleted merely because it looks old.
- The in-memory claim is reserved **synchronously before any await**, so two
  concurrent callers can never both believe the lock is free.
- `withLock(key, fn, { ttlMs, waitMs })` throws `INSTANCE_BUSY` immediately unless
  `waitMs` is set; a heartbeat refreshes the acquisition time for long
  operations.
- `cleanupStale()` runs at startup and reclaims orphaned locks.

## Single process

Run **one** service process against each `DATA_DIR`. Do not run multiple replicas
against the same directory: cross-process coordination is not implemented. The
in-memory mutex is a correctness guarantee only within one process.

## Backup and restore

**Back up:**

- the whole `DATA_DIR` (keys, instances, sessions, deliveries, audit), and
- the **encryption keyring** (`ENCRYPTION_KEYS` / `ENCRYPTION_KEYS_FILE`)
  separately, in your secret manager.

A backup without the keyring cannot be restored, because session archives,
message bodies and delivery recipients are encrypted with it.

**Restore:**

1. Stop the service.
2. Restore the directory to the same path.
3. Start the service. Previously-live `cloud_api` instances reconnect
   automatically (if `AUTO_RECONNECT_ON_STARTUP=true`); web instances require the
   owner to re-scan a QR code.

See [Operations → Backup and restore](./operations.md#backup-and-restore).

## Permissions and hosting

- Create `DATA_DIR` with `0700`, owned by the process user (the `node` user in the
  container).
- Never make `DATA_DIR` world-readable.
- Never place `DATA_DIR` inside the image, a static/download directory, or version
  control (`.gitignore` excludes `data/`).
- The web connector's `local` browser profile is **not** encrypted by this
  service. Store `DATA_DIR` on an encrypted volume, or use
  `WHATSAPP_WEB_AUTH_STRATEGY=remote_encrypted`.

## Related

- [Data retention and privacy](./data-retention.md)
- [Security](./security.md)
- [Operations](./operations.md)
