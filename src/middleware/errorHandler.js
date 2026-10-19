/**
 * Centralised error handling and consistent JSON error responses.
 *
 * Guarantees:
 *  - a stable machine-readable `code`, a safe `message` and the `requestId`;
 *  - no stack traces, file paths, SQL, secrets, QR payloads or session data in
 *    production responses (or in any response, for that matter);
 *  - unexpected errors are logged in full server-side and reported as a generic
 *    500 to the caller.
 */
import { AppError, ErrorCode } from '../utils/errors.js';
import { getRequestId } from './requestId.js';

export function notFoundHandler(req, res) {
  const requestId = getRequestId(req);
  res.status(404).json({
    success: false,
    error: { code: ErrorCode.NOT_FOUND, message: 'The requested endpoint does not exist.' },
    requestId,
  });
}

export function createErrorHandler({ logger }) {
  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  return function errorHandler(error, req, res, next) {
    const requestId = getRequestId(req);

    if (res.headersSent) {
      // Streams (SSE) may already have flushed headers: terminate the response.
      logger?.warn({ err: error, requestId }, 'error after response headers were sent; aborting response');
      res.destroy?.();
      return;
    }

    const mapped = mapError(error);

    if (mapped.status >= 500) {
      logger?.error(
        {
          err: error,
          requestId,
          method: req.method,
          path: req.path,
          errorCode: mapped.code,
        },
        'unhandled request error',
      );
    } else {
      logger?.warn(
        { requestId, method: req.method, path: req.path, errorCode: mapped.code, status: mapped.status },
        'request rejected',
      );
    }

    const body = {
      success: false,
      error: { code: mapped.code, message: mapped.message },
      requestId,
    };
    if (mapped.details !== undefined) body.error.details = mapped.details;
    if (mapped.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(mapped.retryAfterSeconds));

    res.status(mapped.status).json(body);
  };
}

export function mapError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.expose ? error.message : 'Internal server error.',
      details: error.expose ? error.details : undefined,
      retryAfterSeconds: error.details?.retryAfterSeconds,
    };
  }

  // Body parser failures.
  if (error?.type === 'entity.too.large') {
    return { status: 413, code: ErrorCode.PAYLOAD_TOO_LARGE, message: 'The request body is too large.' };
  }
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return { status: 400, code: ErrorCode.INVALID_JSON, message: 'The request body is not valid JSON.' };
  }
  if (error?.type === 'encoding.unsupported' || error?.type === 'charset.unsupported') {
    return { status: 415, code: ErrorCode.VALIDATION_ERROR, message: 'The request encoding is not supported.' };
  }
  if (error?.status === 400) {
    return { status: 400, code: ErrorCode.VALIDATION_ERROR, message: 'The request could not be processed.' };
  }

  return { status: 500, code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error.' };
}
