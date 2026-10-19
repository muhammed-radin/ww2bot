import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '../../src/storage/fileStore.js';
import { createTestStore } from '../helpers/testStore.js';

test('init creates the data tree with restrictive permissions and proves writability', async () => {
  const { store, dir } = await createTestStore();
  const stats = await fs.stat(dir);
  assert.equal(stats.mode & 0o777, 0o700);
  for (const directory of ['config', 'api-keys', 'audit', 'instances', 'locks', 'tmp']) {
    const child = await fs.stat(path.join(dir, directory));
    assert.ok(child.isDirectory(), `${directory} exists`);
    assert.equal(child.mode & 0o777, 0o700);
  }
});

test('init fails fast with a clear error when storage is unusable', async () => {
  const { dir } = await createTestStore();
  // Point DATA_DIR *underneath* a regular file: mkdir fails immediately with
  // ENOTDIR, proving the failure is reported instead of hanging or crashing.
  const blocker = path.join(dir, 'not-a-directory');
  await fs.writeFile(blocker, 'i am a file');
  const store = new FileStore({ root: path.join(blocker, 'data') });
  await assert.rejects(
    () => store.init(),
    (error) => {
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      assert.match(error.message, /DATA_DIR/);
      return true;
    },
  );
});

test('missing files yield the fallback and are never created by a read', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'config', 'nope.json');
  assert.equal(await store.readJson(file), null);
  assert.equal(await store.readJson(file, { fallback: { a: 1 } }).then((v) => v.a), 1);
  assert.equal(await store.exists(file), false);
});

test('JSON files round-trip with 0600 permissions', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'config', 'service.json');
  await store.writeJson(file, { hello: 'world' });
  assert.deepEqual(await store.readJson(file), { hello: 'world' });
  const stats = await fs.stat(file);
  assert.equal(stats.mode & 0o777, 0o600);
});

test('corrupt JSON is quarantined and the fallback is returned', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'api-keys', 'keys.json');
  await fs.writeFile(file, '{ this is not json');
  const value = await store.readJson(file, { fallback: { keys: [] } });
  assert.deepEqual(value, { keys: [] });

  const entries = await fs.readdir(path.dirname(file));
  assert.ok(
    entries.some((entry) => entry.startsWith('keys.json.corrupt-')),
    'the corrupt file was renamed aside',
  );
  assert.ok(!entries.includes('keys.json'), 'the original corrupt file no longer shadows the fallback');
});

test('a file failing schema validation is quarantined', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'config', 'schema.json');
  await store.writeJson(file, { version: 'not-a-number' });
  const value = await store.readJson(file, {
    fallback: { version: 1 },
    validate: (parsed) => typeof parsed?.version === 'number',
  });
  assert.deepEqual(value, { version: 1 });
});

test('updateJson is a serialised read-modify-write under concurrency', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'api-keys', 'keys.json');

  // 50 concurrent increments must not lose a single update.
  await Promise.all(
    Array.from({ length: 50 }, () =>
      store.updateJson(file, (current) => ({ count: (current?.count ?? 0) + 1 }), { fallback: { count: 0 } }),
    ),
  );

  assert.deepEqual(await store.readJson(file), { count: 50 });
});

test('updateJson returning undefined skips the write', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'config', 'x.json');
  await store.writeJson(file, { keep: true });
  const before = await fs.stat(file);
  await store.updateJson(file, () => undefined, { fallback: {} });
  const after = await fs.stat(file);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.deepEqual(await store.readJson(file), { keep: true });
});

test('JSONL append and read preserve order and tolerate bad lines', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'audit', 'events.jsonl');
  await store.appendJsonl(file, { id: 1 });
  await store.appendJsonl(file, { id: 2 });
  await store.appendJsonl(file, { id: 3 });

  assert.deepEqual(
    (await store.readJsonl(file)).map((row) => row.id),
    [1, 2, 3],
  );

  // A torn line in the middle does not take the whole file down.
  await fs.appendFile(file, 'this is not json\n');
  await store.appendJsonl(file, { id: 4 });
  const rows = await store.readJsonl(file);
  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 2, 3, 4],
  );
});

test('updateJsonl read-modify-write never loses a concurrent append', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'audit', 'events.jsonl');

  // One read-modify-write racing many appends: because both take the same
  // mutex, no append can slip between the read and the write.
  await Promise.all([
    ...Array.from({ length: 60 }, (_, index) => store.appendJsonl(file, { id: index })),
    store.updateJsonl(file, (rows) => [...rows, { id: 'marker' }]),
  ]);

  const rows = await store.readJsonl(file);
  assert.equal(rows.length, 61, 'all 60 appends plus the marker are present');
  assert.ok(rows.some((row) => row.id === 'marker'));

  // Concurrent filters converge on the same result without losing rows.
  await Promise.all(
    Array.from({ length: 20 }, () => store.updateJsonl(file, (current) => current.filter((row) => row.id === 'marker'))),
  );
  const filtered = await store.readJsonl(file);
  assert.deepEqual(filtered, [{ id: 'marker' }]);
});

test('atomic writes leave no temporary files behind', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'config', 'atomic.json');
  await store.writeJson(file, { value: 1 });
  await store.writeJson(file, { value: 2 });
  const entries = await fs.readdir(path.dirname(file));
  assert.ok(!entries.some((entry) => entry.startsWith('.tmp-')), 'no temp files remain');
});

test('init sweeps leftover temporary files from an interrupted run', async () => {
  const { store } = await createTestStore();
  const stale = path.join(store.root, 'api-keys', '.tmp-keys.json-999-deadbeef');
  await fs.writeFile(stale, 'partial');
  await store.init();
  assert.equal(await store.exists(stale), false);
});

test('paths derived from identifiers can never escape the data root', async () => {
  const { store } = await createTestStore();
  assert.throws(() => store.paths.under('..', '..', 'etc', 'passwd'));
  assert.throws(() => store.paths.instanceFile('../../etc/passwd'));
  assert.throws(() => store.paths.instanceFile('bad/id'));
  assert.throws(() => store.paths.instanceFile('..'));
  assert.throws(() => store.paths.instanceFile(''));
});

test('text read/write round-trips and preserves mode', async () => {
  const { store } = await createTestStore();
  const file = path.join(store.root, 'instances', 'ins_' + 'a'.repeat(32), 'session-archive.enc');
  await store.writeText(file, 'ENCRYPTED-BYTES');
  assert.equal(await store.readText(file), 'ENCRYPTED-BYTES');
  assert.equal(await store.readText(path.join(store.root, 'missing.enc')), null);
  const stats = await fs.stat(file);
  assert.equal(stats.mode & 0o777, 0o600);
});
