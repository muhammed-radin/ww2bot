/**
 * Encrypted session store (whatsapp-web.js RemoteAuth `Store` adapter).
 *
 * The store must persist only ciphertext, round-trip the archive exactly, and
 * refuse to act on behalf of a different instance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { SessionService } from '../../src/services/session.service.js';
import { createEncryptedSessionStore } from '../../src/connectors/web/sessionStore.js';
import { AppError } from '../../src/utils/errors.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';
import { createTestRepositories } from '../helpers/testStore.js';

async function build() {
  const config = loadConfig({ ...BASE_TEST_ENV });
  const logger = createLogger(config);
  const { repositories, encryption, store: fileStore, dir } = await createTestRepositories({ logger });
  const sessionService = new SessionService({
    config,
    encryption,
    repository: repositories.sessions,
    logger,
    paths: fileStore.paths,
  });
  const instance = { id: `ins_${'a'.repeat(32)}`, tenantId: 'tenant-a' };
  const store = createEncryptedSessionStore({ sessionService, instance, logger });
  return { sessionDir: dir, sessionService, instance, store, repositories };
}

const cleanup = (directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => {});

test('the archive is saved as ciphertext and never in plaintext', async () => {
  const { sessionDir, sessionService, instance, store, repositories } = await build();
  const archiveBytes = Buffer.from('PRIVATE-SESSION-MATERIAL-'.repeat(20));

  const source = path.join(sessionDir, 'source.zip');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, archiveBytes);

  assert.equal(await store.save({ session: instance.id, path: source }), true);

  const record = await repositories.sessions.get(instance.id);
  assert.ok(record, 'a session record was stored');
  assert.match(record.ciphertext, /^ENC:v1:k1:/);
  assert.equal(record.strategy, 'remote_encrypted');
  assert.equal(record.keyId, 'k1');
  assert.equal(record.ciphertext.includes('PRIVATE-SESSION-MATERIAL'), false, 'no plaintext leaks into the row');

  // The decrypted archive matches the original byte-for-byte.
  const decrypted = await sessionService.loadEncryptedArchive(instance);
  assert.deepEqual(decrypted, archiveBytes);

  await cleanup(sessionDir);
});

test('extract decrypts the archive back to disk with private permissions', async () => {
  const { sessionDir, instance, store } = await build();
  const archiveBytes = Buffer.from('archive-contents-for-extract');

  const source = path.join(sessionDir, 'source.zip');
  await fs.writeFile(source, archiveBytes);
  await store.save({ session: instance.id, path: source });

  const target = path.join(sessionDir, 'restore', 'profile.zip');
  assert.equal(await store.extract({ session: instance.id, path: target }), true);
  assert.deepEqual(await fs.readFile(target), archiveBytes);
  const stats = await fs.stat(target);
  assert.equal(stats.mode & 0o777, 0o600);

  await cleanup(sessionDir);
});

test('sessionExists reflects stored material and delete removes it', async () => {
  const { sessionDir, instance, store, repositories } = await build();
  assert.equal(await store.sessionExists({ session: instance.id }), false);

  const source = path.join(sessionDir, 'source.zip');
  await fs.writeFile(source, Buffer.from('x'));
  await store.save({ session: instance.id, path: source });
  assert.equal(await store.sessionExists({ session: instance.id }), true);

  assert.equal(await store.delete({ session: instance.id }), true);
  assert.equal(await store.sessionExists({ session: instance.id }), false);
  assert.equal(await repositories.sessions.get(instance.id), null);

  await cleanup(sessionDir);
});

test('extract fails when no archive has been stored', async () => {
  const { sessionDir, instance, store } = await build();
  await assert.rejects(
    () => store.extract({ session: instance.id, path: path.join(sessionDir, 'nothing.zip') }),
    (error) => error instanceof AppError && error.status === 404,
  );
  await cleanup(sessionDir);
});

test('a session name that is not this instance is refused', async () => {
  const { sessionDir, instance, store } = await build();
  const other = `ins_${'b'.repeat(32)}`;
  const source = path.join(sessionDir, 'source.zip');
  await fs.writeFile(source, Buffer.from('x'));

  for (const call of [
    () => store.save({ session: other, path: source }),
    () => store.extract({ session: other, path: path.join(sessionDir, 'out.zip') }),
    () => store.delete({ session: other }),
    () => store.sessionExists({ session: other }),
  ]) {
    await assert.rejects(call, (error) => error instanceof AppError && error.status === 403);
  }

  await cleanup(sessionDir);
});
