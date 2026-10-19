/**
 * Uniform success responses.
 * Error responses are produced centrally by the error handler, so every 4xx/5xx
 * shares one shape: {success:false, error:{code,message}, requestId}.
 */

export function ok(res, data, { status = 200, pagination } = {}) {
  const body = { success: true, data };
  if (pagination) body.pagination = pagination;
  return res.status(status).json(body);
}

export function created(res, data, options = {}) {
  return ok(res, data, { ...options, status: 201 });
}

export function paginationMeta({ limit, hasMore, nextCursor, returned }) {
  return {
    limit,
    returned: returned ?? null,
    hasMore: Boolean(hasMore),
    nextCursor: nextCursor ?? null,
  };
}
