/**
 * Shared test storage helpers.
 *
 * Unit tests need real file-backed repositories (the production path) without
 * spinning up an HTTP server. This helper creates a throwaway `DATA_DIR`, wires
 * a `FileStore`, an `EncryptionService` and the repository factory, and keeps
 * track of the directories so they are removed when the test file's event loop
 * drains.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../../src/storage/fileStore.js';
import { EncryptionService } from '../../src/services/encryption.service.js';
import { createRepositories } from '../../src/repositories/index.js';
import { TEST_KEY_RING } from './testApp.js';

const trackedDirs = [];
let hooked = false;

function track(dir) {
  trackedDirs.push(dir);
  if (!hooked) {
    hooked = true;
    process.on('beforeExit', () => {
      for (const d of trackedDirs) {
        try {
          fsSync.rmSync(d, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });
  }
}

/** Create an initialised `FileStore` rooted at a fresh temp directory. */
export async function createTestStore({ prefix = 'rb-wa-store-', dir: providedDir = null } = {}) {
  const dir = providedDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  track(dir);
  const store = new FileStore({ root: dir });
  await store.init();
  return { store, dir };
}

export function createTestEncryption(logger = null) {
  return new EncryptionService({ keys: TEST_KEY_RING, activeKeyId: 'k1', logger });
}

/** File-backed repositories over a temp data directory. */
export async function createTestRepositories({ logger = null, prefix = 'rb-wa-store-', dir = null } = {}) {
  const { store, dir: root } = await createTestStore({ prefix, dir });
  const encryption = createTestEncryption(logger);
  const repositories = createRepositories({ store, encryption, logger });
  return { store, dir: root, encryption, repositories };
}
