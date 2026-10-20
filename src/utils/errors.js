/**
 * Error taxonomy. Every error that crosses the HTTP boundary is an AppError so
 * the error handler can map it to a stable machine-readable code and status
 * without ever leaking internals, stack traces or secrets.
 */

export const ErrorCode = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_CURSOR: 'INVALID_CURSOR',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED',
  CONNECTOR_DISABLED: 'CONNECTOR_DISABLED',
  CONNECTOR_ERROR: 'CONNECTOR_ERROR',
  CONNECTOR_UNAVAILABLE: 'CONNECTOR_UNAVAILABLE',
  INSTANCE_NOT_CONNECTED: 'INSTANCE_NOT_CONNECTED',
  INSTANCE_BUSY: 'INSTANCE_BUSY',
  INSTANCE_LIMIT_REACHED: 'INSTANCE_LIMIT_REACHED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_STREAM_TOKEN: 'INVALID_STREAM_TOKEN',
  RETENTION_DISABLED: 'RETENTION_DISABLED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
});

export class AppError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message safe, human-readable message
   * @param {object} [options]
   * @param {number} [options.status] HTTP status
   * @param {unknown} [options.details] extra safe details returned to the client
   * @param {boolean} [options.expose] whether the message is safe to return.
   *   Defaults to `status < 500`; curated 5xx subclasses opt in explicitly
   *   because their messages are authored to be safe and actionable.
   * @param {Error} [options.cause]
   */
  constructor(code, message, { status = 500, details, expose, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = expose ?? status < 500;
    this.isOperational = true;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed.', details) {
    super(ErrorCode.VALIDATION_ERROR, message, { status: 400, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'A valid API key is required.', details = null) {
    // Callers may override the code (e.g. INVALID_STREAM_TOKEN) by passing
    // `{ code }` inside details; any remaining keys stay as safe details.
    const { code = ErrorCode.UNAUTHORIZED, ...rest } =
      details && typeof details === 'object' ? details : {};
    super(code, message, { status: 401, details: Object.keys(rest).length > 0 ? rest : undefined });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'The API key is not permitted to perform this action.', details) {
    // Callers may override the code (e.g. IP_NOT_ALLOWED) by passing `{ code }`
    // inside details; any remaining keys stay as safe details.
    const { code = ErrorCode.FORBIDDEN, ...rest } = details && typeof details === 'object' ? details : {};
    super(code, message, { status: 403, details: Object.keys(rest).length > 0 ? rest : undefined });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', details) {
    super(ErrorCode.NOT_FOUND, message, { status: 404, details });
  }
}

export class ConflictError extends AppError {
  constructor(code, message, details) {
    super(code ?? ErrorCode.CONFLICT, message, { status: 409, details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests.', details) {
    super(ErrorCode.RATE_LIMITED, message, { status: 429, details });
  }
}

export class CapabilityNotSupportedError extends AppError {
  constructor(message, details) {
    // 501, but the message is curated ("the connector cannot do X because Y"):
    // it is safe and useful to return, so it is exposed deliberately.
    super(ErrorCode.CAPABILITY_NOT_SUPPORTED, message, { status: 501, details, expose: true });
  }
}

export class ConnectorDisabledError extends AppError {
  constructor(message, details) {
    super(ErrorCode.CONNECTOR_DISABLED, message, { status: 409, details });
  }
}

export class ConnectorError extends AppError {
  constructor(message, details, { cause } = {}) {
    // 502, but the message is authored safe ("the linked session is not
    // readable"): returning it is what makes a connector failure actionable
    // instead of a bare "Internal server error.".
    super(ErrorCode.CONNECTOR_ERROR, message, { status: 502, details, expose: true, cause });
  }
}

export class InstanceNotConnectedError extends AppError {
  constructor(message = 'The instance is not connected.', details) {
    super(ErrorCode.INSTANCE_NOT_CONNECTED, message, { status: 409, details });
  }
}

export class InstanceBusyError extends AppError {
  constructor(message = 'Another operation is already in progress for this instance.', details) {
    super(ErrorCode.INSTANCE_BUSY, message, { status: 409, details });
  }
}

export class ProviderError extends AppError {
  constructor(message, details) {
    super(ErrorCode.PROVIDER_ERROR, message, { status: 502, details, expose: true });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'A required dependency is unavailable.', details) {
    super(ErrorCode.SERVICE_UNAVAILABLE, message, { status: 503, details, expose: true });
  }
}

export function isAppError(error) {
  return error instanceof AppError;
}

/** Wrap an unknown thrown value into an AppError for safe handling. */
export function toAppError(error) {
  if (isAppError(error)) return error;
  return new AppError(ErrorCode.INTERNAL_ERROR, 'Internal server error.', { cause: error });
}
