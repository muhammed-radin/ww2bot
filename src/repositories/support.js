/**
 * Shared helpers for the file-backed repository implementations.
 */

/** Coerce a stored timestamp (ISO string or Date) to epoch milliseconds. */
export function toMillis(value) {
  if (value === null || value === undefined) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * JSON round-trips Dates to ISO strings. Revive the fields a repository knows
 * are timestamps so callers can keep using Date methods on them.
 * @template T
 * @param {T} record
 * @param {string[]} fields
 * @returns {T}
 */
export function reviveDates(record, fields) {
  if (!record || typeof record !== 'object') return record;
  for (const field of fields) {
    if (record[field] !== null && record[field] !== undefined) {
      const date = new Date(record[field]);
      record[field] = Number.isNaN(date.getTime()) ? null : date;
    }
  }
  return record;
}

/** Deep clone a stored row so callers can never mutate persisted state. */
export function cloneRow(row) {
  return row === null || row === undefined ? row : structuredClone(row);
}

/**
 * Keyset pagination over an in-memory collection, newest first.
 * Ordering contract: (t desc, i desc).
 * @param {object[]} rows
 * @param {{limit:number, cursor:object|null}} options
 * @param {(row:object)=>({t:number|string, i:string})} keyOf
 * @returns {{items:object[], hasMore:boolean}}
 */
export function pageDesc(rows, { limit, cursor }, keyOf) {
  const withKeys = rows.map((row) => ({ row, key: keyOf(row) }));
  withKeys.sort((a, b) => {
    if (a.key.t !== b.key.t) return a.key.t < b.key.t ? 1 : -1;
    return String(a.key.i) < String(b.key.i) ? 1 : -1;
  });

  let filtered = withKeys;
  if (cursor) {
    filtered = withKeys.filter(({ key }) => {
      if (key.t < cursor.t) return true;
      if (key.t > cursor.t) return false;
      return String(key.i) < String(cursor.i);
    });
  }

  const window = filtered.slice(0, limit + 1);
  const hasMore = window.length > limit;
  const items = (hasMore ? window.slice(0, limit) : window).map(({ row }) => row);
  return { items, hasMore };
}
