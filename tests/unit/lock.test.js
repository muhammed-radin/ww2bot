import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFileLock } from '../../src/storage/fileLock.js';
import { InstanceBusyError } from '../../src/utils/errors.js';

async function makeLockDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rb-wa-lock-'));
}

function fileNameFor(key) {
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}.lock`;
}

test('a lock admits one holder at a time', async () => {
  const lock = createFileLock({ lockDir: await makeLockDir() });
  let released = false;

  const first = lock.withLock('instance:ins_a:connect', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    released = true;
  });

  await assert.rejects(
    () => lock.withLock('instance:ins_a:connect', async () => 'second'),
    InstanceBusyError,
  );
  await first;
  assert.equal(released, true);
});

test('different keys do not block each other', async () => {
  const lock = createFileLock({ lockDir: await makeLockDir() });
  const results = await Promise.all([
    lock.withLock('a', async () => 'a'),
    lock.withLock('b', async () => 'b'),
  ]);
  assert.deepEqual(results, ['a', 'b']);
});

test('the lock is released even when the critical section throws', async () => {
  const lock = createFileLock({ lockDir: await makeLockDir() });
  await assert.rejects(() =>
    lock.withLock('key', async () => {
      throw new Error('boom');
    }),
  );
  // Re-acquiring proves the lock was released.
  assert.equal(await lock.withLock('key', async () => 'ok'), 'ok');
});

test('withLock can wait for the lock to become free', async () => {
  const lock = createFileLock({ lockDir: await makeLockDir() });
  const order = [];
  const holder = lock.withLock('key', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push('first');
  });
  const waiter = lock.withLock('key', async () => order.push('second'), { waitMs: 500 });
  await Promise.all([holder, waiter]);
  assert.deepEqual(order, ['first', 'second']);
});

test('a lock cannot be released by a non-owner', async () => {
  const lock = createFileLock({ lockDir: await makeLockDir() });
  const token = await lock.acquire('key');
  assert.ok(token);
  await lock.release('key', 'not-the-owner');
  // Still locked, so a second acquire fails.
  assert.equal(await lock.acquire('key'), null);
  await lock.release('key', token);
  assert.ok(await lock.acquire('key'));
});

test('a stale lock file whose owning process is gone is reclaimed', async () => {
  const lockDir = await makeLockDir();
  const lock = createFileLock({ lockDir });
  const key = 'instance:ins_dead:connect';

  // Simulate a lock left behind by a crashed process (pid that cannot exist).
  await fs.writeFile(
    path.join(lockDir, fileNameFor(key)),
    JSON.stringify({ key, token: 'dead-token', pid: 2147483646, op: 'connect', acquiredAt: new Date(0).toISOString() }),
  );

  const token = await lock.acquire(key);
  assert.ok(token, 'a lock owned by a dead process is reclaimed');
  await lock.release(key, token);
});

test('a lock file owned by a live process is not stolen', async () => {
  const lockDir = await makeLockDir();
  const lock = createFileLock({ lockDir });
  const key = 'instance:ins_other:connect';

  // Another live process (init) owns the lock.
  await fs.writeFile(
    path.join(lockDir, fileNameFor(key)),
    JSON.stringify({ key, token: 'foreign', pid: 1, op: 'connect', acquiredAt: new Date().toISOString() }),
  );

  assert.equal(await lock.acquire(key), null, 'the live owner keeps the lock');
});

test('cleanupStale reclaims only locks owned by dead processes', async () => {
  const lockDir = await makeLockDir();
  const lock = createFileLock({ lockDir });

  await fs.writeFile(
    path.join(lockDir, fileNameFor('dead')),
    JSON.stringify({ key: 'dead', token: 't', pid: 2147483646 }),
  );
  await fs.writeFile(
    path.join(lockDir, fileNameFor('live')),
    JSON.stringify({ key: 'live', token: 't', pid: 1 }),
  );

  const removed = await lock.cleanupStale();
  assert.equal(removed, 1);
  const remaining = await fs.readdir(lockDir);
  assert.equal(remaining.length, 1);
});
