/**
 * Validated filesystem layout for file-based persistence.
 *
 * Every path used by a repository is derived from an internal identifier that
 * has already been validated (instance id, key id, ...). Callers never pass an
 * arbitrary path, and every generated path is asserted to stay inside the data
 * root, so a crafted identifier can never escape the storage directory.
 */
import path from 'node:path';
import { ErrorCode, ValidationError } from '../utils/errors.js';

/** Conservative, filesystem-safe identifier alphabet. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.:@-]{1,128}$/;

export function assertSafeSegment(value, field = 'path segment') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ValidationError(`Invalid ${field}.`, { field, code: ErrorCode.VALIDATION_ERROR });
  }
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new ValidationError(`Invalid ${field}.`, { field, code: ErrorCode.VALIDATION_ERROR });
  }
  return value;
}

/**
 * Build the path helpers for a data root.
 * @param {{root:string}} options
 */
export function createPaths({ root }) {
  const base = path.resolve(root);

  const within = (candidate) =>
    candidate === base || candidate.startsWith(`${base}${path.sep}`);

  /** Join validated segments under the data root and assert containment. */
  function under(...segments) {
    const joined = path.join(base, ...segments);
    if (!within(joined)) {
      throw new ValidationError('Refusing to use a path outside the data directory.', {
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return joined;
  }

  const instanceDir = (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'));

  return {
    root: base,
    within,
    under,

    configDir: under('config'),
    serviceConfigFile: under('config', 'service.json'),

    apiKeysDir: under('api-keys'),
    apiKeysFile: under('api-keys', 'keys.json'),

    auditDir: under('audit'),
    auditFile: under('audit', 'events.jsonl'),

    instancesDir: under('instances'),
    instancesIndexFile: under('instances', 'index.json'),

    locksDir: under('locks'),
    tmpDir: under('tmp'),
    rateLimitsDir: under('rate-limits'),

    instanceDir,
    instanceFile: (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'), 'instance.json'),
    connectionFile: (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'), 'connection.json'),
    messagesFile: (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'), 'messages.jsonl'),
    autorepliesFile: (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'), 'autoreplies.json'),
    webhookEventsFile: (instanceId) =>
      under('instances', assertSafeSegment(instanceId, 'instanceId'), 'webhook-events.jsonl'),
    deliveriesFile: (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'), 'deliveries.jsonl'),
    sessionArchiveFile: (instanceId) =>
      under('instances', assertSafeSegment(instanceId, 'instanceId'), 'session-archive.enc'),
    sessionArchiveMetaFile: (instanceId) =>
      under('instances', assertSafeSegment(instanceId, 'instanceId'), 'session-archive.meta.json'),
    browserProfileDir: (instanceId) => under('instances', assertSafeSegment(instanceId, 'instanceId'), 'session'),

    lockFile: (key) => under('locks', `${assertSafeSegment(sanitiseLockKey(key), 'lock key')}.lock`),
  };
}

/** Lock keys contain ':' which is illegal on some filesystems; map to a safe form. */
function sanitiseLockKey(key) {
  return String(key).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
}
