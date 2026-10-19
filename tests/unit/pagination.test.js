import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPage,
  createCursorCodec,
  nextCursorFrom,
  parsePagination,
} from '../../src/utils/pagination.js';
import { ValidationError } from '../../src/utils/errors.js';

const config = { defaultPageSize: 25, maxPageSize: 100 };
const codec = createCursorCodec('cursor-secret-for-tests');

test('cursors round trip and carry their kind', () => {
  const cursor = codec.encode({ k: 'instances', t: 1700000000000, i: 'ins_x' });
  const decoded = codec.decode(cursor, { kind: 'instances' });
  assert.equal(decoded.t, 1700000000000);
  assert.equal(decoded.i, 'ins_x');
  assert.equal(decoded.v, 1);
});

test('cursors are tamper evident', () => {
  const cursor = codec.encode({ k: 'instances', t: 1, i: 'a' });
  const [body, signature] = cursor.split('.');

  assert.throws(() => codec.decode(`${body}.${signature.slice(0, -2)}xx`), ValidationError);
  assert.throws(() => codec.decode('garbage'), ValidationError);
  assert.throws(() => codec.decode(''), ValidationError);
  assert.throws(() => codec.decode('a.'.repeat(1) + 'b'.repeat(600)), ValidationError);

  // A cursor signed with a different secret is rejected.
  const otherCodec = createCursorCodec('a-different-secret');
  assert.throws(() => otherCodec.decode(cursor), /signature is invalid/);
});

test('a cursor cannot be replayed against another collection', () => {
  const cursor = codec.encode({ k: 'chats', t: 5, i: 'c' });
  assert.throws(() => codec.decode(cursor, { kind: 'messages' }), ValidationError);
});

test('pagination parsing enforces integer limits and the maximum', () => {
  assert.deepEqual(parsePagination({}, config, { codec }), { limit: 25, cursor: null });
  assert.equal(parsePagination({ limit: '10' }, config, { codec }).limit, 10);
  assert.throws(() => parsePagination({ limit: '0' }, config, { codec }), ValidationError);
  assert.throws(() => parsePagination({ limit: '-1' }, config, { codec }), ValidationError);
  assert.throws(() => parsePagination({ limit: 'abc' }, config, { codec }), ValidationError);
  assert.throws(() => parsePagination({ limit: '101' }, config, { codec }), /must not exceed 100/);
  assert.throws(() => parsePagination({ limit: '1.5' }, config, { codec }), ValidationError);
});

test('pagination parsing decodes a valid cursor and rejects a forged one', () => {
  const cursor = codec.encode({ k: 'chats', t: 10, i: 'abc' });
  const parsed = parsePagination({ cursor }, config, { kind: 'chats', codec });
  assert.equal(parsed.cursor.i, 'abc');
  assert.throws(() => parsePagination({ cursor: 'forged.abc' }, config, { kind: 'chats', codec }), ValidationError);
});

test('buildPage uses a look-ahead row to decide hasMore', () => {
  const rows = Array.from({ length: 4 }, (_value, index) => ({ n: index }));
  const limit = 3;

  // Exactly `limit` rows means there is nothing more to fetch.
  const exact = buildPage(rows.slice(0, limit), limit, (row) => ({ t: row.n, i: `id-${row.n}` }), codec, 'items');
  assert.equal(exact.items.length, 3);
  assert.equal(exact.nextCursor, null, 'no look-ahead row means no cursor');

  // One extra (look-ahead) row signals that more results exist.
  const withLookahead = buildPage(rows, limit, (row) => ({ t: row.n, i: `id-${row.n}` }), codec, 'items');
  assert.equal(withLookahead.items.length, 3);
  const lookaheadDecoded = codec.decode(withLookahead.nextCursor, { kind: 'items' });
  assert.equal(lookaheadDecoded.i, 'id-2');

  const smaller = buildPage(rows, 2, (row) => ({ t: row.n, i: `id-${row.n}` }), codec, 'items');
  assert.equal(smaller.items.length, 2);
  const decoded = codec.decode(smaller.nextCursor, { kind: 'items' });
  assert.equal(decoded.i, 'id-1');
});

test('nextCursorFrom points at the last returned item', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const cursor = nextCursorFrom(items, true, (item) => ({ t: 7, i: item.id }), codec, 'x');
  assert.equal(codec.decode(cursor, { kind: 'x' }).i, 'b');
  assert.equal(nextCursorFrom(items, false, () => ({ t: 7, i: 'a' }), codec, 'x'), null);
  assert.equal(nextCursorFrom([], true, () => ({ t: 1, i: 'a' }), codec, 'x'), null);
});
