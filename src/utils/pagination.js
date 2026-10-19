/**
 * Opaque, tamper-evident keyset pagination cursors.
 *
 * Cursors are signed with a key derived from the API-key pepper, so a client
 * cannot forge or reuse a cursor to escape its own authorisation scope. Every
 * cursor is validated (structure, signature, endpoint kind) before use.
 */
import crypto from 'node:crypto';
import { ErrorCode, ValidationError } from './errors.js';

const CURSOR_VERSION = 1;
const SIGNATURE_BYTES = 16;

export function createCursorCodec(secret) {
  const key = crypto.createHash('sha256').update(`cursor:${secret}`).digest();

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', key).update(body).digest().subarray(0, SIGNATURE_BYTES).toString('base64url');
    return `${body}.${signature}`;
  }

  return {
    /** @param {object} payload @returns {string} */
    encode(payload) {
      return sign({ v: CURSOR_VERSION, ...payload });
    },

    /**
     * @param {string} cursor
     * @param {{kind?: string}} [options]
     * @returns {object} decoded payload
     */
    decode(cursor, { kind } = {}) {
      if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) {
        throw new ValidationError('The cursor is malformed.', { field: 'cursor' });
      }
      const [body, signature] = cursor.split('.');
      if (!body || !signature) {
        throw new ValidationError('The cursor is malformed.', { field: 'cursor' });
      }
      const expected = crypto.createHmac('sha256', key).update(body).digest().subarray(0, SIGNATURE_BYTES).toString('base64url');
      const provided = Buffer.from(signature);
      const wanted = Buffer.from(expected);
      if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
        throw new ValidationError('The cursor signature is invalid.', { field: 'cursor', code: ErrorCode.INVALID_CURSOR });
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw new ValidationError('The cursor is malformed.', { field: 'cursor' });
      }
      if (!payload || payload.v !== CURSOR_VERSION) {
        throw new ValidationError('The cursor version is not supported.', { field: 'cursor' });
      }
      if (kind && payload.k !== undefined && payload.k !== kind) {
        throw new ValidationError('The cursor was issued for a different collection.', { field: 'cursor' });
      }
      return payload;
    },
  };
}

/**
 * Read and validate limit/cursor from a parsed query object.
 * @param {object} query
 * @param {{defaultPageSize:number, maxPageSize:number}} pagination
 * @param {{kind?:string, codec:ReturnType<typeof createCursorCodec>}} options
 */
export function parsePagination(query, pagination, { kind, codec } = {}) {
  const rawLimit = query?.limit;
  let limit = pagination.defaultPageSize;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ValidationError('"limit" must be a positive integer.', { field: 'limit' });
    }
    if (parsed > pagination.maxPageSize) {
      throw new ValidationError(`"limit" must not exceed ${pagination.maxPageSize}.`, {
        field: 'limit',
        max: pagination.maxPageSize,
      });
    }
    limit = parsed;
  }

  let cursorPayload = null;
  if (query?.cursor !== undefined && query.cursor !== '') {
    cursorPayload = codec.decode(String(query.cursor), { kind });
  }

  return { limit, cursor: cursorPayload };
}

/**
 * Build a page from a result set that was fetched with `limit + 1` rows.
 * @param {Array<object>} rows rows including the look-ahead row
 * @param {number} limit
 * @param {(row:object)=>({t:number|string, i:string})} keyOf
 * @param {ReturnType<typeof createCursorCodec>} codec
 * @param {string} kind
 */
export function buildPage(rows, limit, keyOf, codec, kind) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const key = keyOf(items[items.length - 1]);
    nextCursor = codec.encode({ k: kind, t: key.t, i: key.i });
  }
  return { items, nextCursor };
}

/**
 * Apply a decoded cursor to an in-memory, already-sorted collection.
 * Ordering contract: newest first by (t desc, i desc).
 */
export function applyMemoryCursor(rows, cursor) {
  if (!cursor) return rows;
  const t = cursor.t;
  const i = cursor.i;
  return rows.filter((row) => {
    if (row.t < t) return true;
    if (row.t > t) return false;
    return String(row.i) < String(i);
  });
}

/**
 * Build the next cursor for a page whose `hasMore` flag came from the data
 * layer (rather than from a look-ahead row). The cursor points at the last item
 * that was actually returned.
 */
export function nextCursorFrom(items, hasMore, keyOf, codec, kind) {
  const last = items[items.length - 1];
  if (!hasMore || !last || !codec) return null;
  const key = keyOf(last);
  return codec.encode({ k: kind, t: key.t, i: key.i });
}
