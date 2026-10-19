/**
 * Request validation.
 *
 * Every route declares zod schemas for params, query and body. Validated values
 * are exposed on `req.valid` rather than by mutating `req.query`/`req.body`, so
 * nothing downstream can accidentally read unvalidated input. Error details
 * contain paths and messages only — never the offending value, which could be a
 * credential.
 */
import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';

export function validate({ params, query, body } = {}) {
  return (req, _res, next) => {
    const issues = [];
    const valid = { params: {}, query: {}, body: undefined };

    for (const [source, schema] of [
      ['params', params],
      ['query', query],
      ['body', body],
    ]) {
      if (!schema) {
        if (source === 'params') valid.params = req.params ?? {};
        if (source === 'query') valid.query = req.query ?? {};
        continue;
      }
      const result = schema.safeParse(req[source] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            source,
            path: [source, ...issue.path].join('.'),
            message: issue.message,
            code: issue.code,
          });
        }
        continue;
      }
      valid[source] = result.data;
    }

    if (issues.length > 0) {
      return next(new ValidationError('Request validation failed.', { issues }));
    }

    req.valid = valid;
    return next();
  };
}

/* -------------------------------------------------------------------------- */
/* shared schemas                                                             */
/* -------------------------------------------------------------------------- */

export const instanceIdParams = z.object({
  instanceId: z
    .string()
    .regex(/^ins_[a-f0-9]{32}$/, 'must be a valid instance id'),
});

export const paginationQuery = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'must be a positive integer')
    .optional(),
  cursor: z.string().min(1).max(512).optional(),
});

export const dateFilters = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
});

export const chatIdParams = instanceIdParams.extend({
  chatId: z
    .string()
    .min(5)
    .max(80)
    .regex(/^[A-Za-z0-9@._-]+$/, 'must be a valid chat id'),
});

/** Reject a filter window that is inverted or absurdly wide (> 366 days). */
export function assertDateWindow(since, until) {
  if (!since || !until) return;
  const from = new Date(since).getTime();
  const to = new Date(until).getTime();
  if (from > to) {
    throw new ValidationError('"since" must be earlier than "until".', { fields: ['since', 'until'] });
  }
  const MAX_WINDOW_MS = 366 * 86400000;
  if (to - from > MAX_WINDOW_MS) {
    throw new ValidationError('The date window must not exceed 366 days.', { fields: ['since', 'until'] });
  }
}
