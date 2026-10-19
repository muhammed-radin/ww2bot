/**
 * Rate limiting (single-process, in-memory).
 *
 * Limits are applied per API key **and** per IP address by composing both into
 * the bucket key, so neither a single key behind many IPs nor many keys behind
 * one IP can exceed the configured budget. Counters live in this process only
 * and therefore reset when the service restarts; that is documented and is the
 * right trade-off for a single-owner, filesystem-backed deployment.
 */
import { RateLimitError } from '../utils/errors.js';

/** Create an in-memory fixed-window counter store. */
export function createRateLimitStore() {
  const buckets = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60000);
  sweeper.unref?.();

  return {
    async increment(key, windowMs) {
      const now = Date.now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        const bucket = { count: 1, resetAt: now + windowMs };
        buckets.set(key, bucket);
        return { count: 1, resetAt: bucket.resetAt };
      }
      existing.count += 1;
      return { count: existing.count, resetAt: existing.resetAt };
    },
    async reset(key) {
      buckets.delete(key);
    },
    async size() {
      return buckets.size;
    },
    async close() {
      clearInterval(sweeper);
      buckets.clear();
    },
  };
}

/**
 * Build an Express rate-limit middleware.
 * @param {object} options
 * @param {number} options.windowMs
 * @param {number} options.max
 * @param {string} options.scope bucket namespace (route family)
 * @param {object} options.store
 * @param {(req:object)=>string} [options.keyGenerator] extra key material
 */
export function createRateLimiter({ windowMs, max, scope, store, keyGenerator, message = 'Too many requests.', skip = null }) {
  return async function rateLimiter(req, res, next) {
    try {
      if (skip && skip(req)) return next();

      const ip = req.ip ?? 'unknown';
      const keyMaterial = keyGenerator ? keyGenerator(req) : '';
      const key = `${scope}:${ip}:${keyMaterial}`;

      const { count, resetAt } = await store.increment(key, windowMs);
      const remaining = Math.max(max - count, 0);
      const resetSeconds = Math.max(Math.ceil((resetAt - Date.now()) / 1000), 0);

      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(resetSeconds));

      if (count > max) {
        res.setHeader('Retry-After', String(resetSeconds));
        throw new RateLimitError(message, { scope, limit: max, windowMs, retryAfterSeconds: resetSeconds });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
