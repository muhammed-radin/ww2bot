/**
 * Centralised API client.
 *
 * Everything the dashboard talks to goes through here:
 *   - same-origin requests (`/api/v1`, `/health`) with credentials, so the
 *     HttpOnly owner-session cookie is sent automatically;
 *   - a single place that attaches the per-session CSRF token to state-changing
 *     requests;
 *   - consistent error handling: callers always get an `ApiError` with a safe,
 *     human-readable message, never a raw stack trace or a secret;
 *   - response-envelope validation, so a malformed body can't masquerade as data;
 *   - request timeouts and abort support.
 *
 * No credential is ever embedded here, and no key is ever stored in the browser.
 */

const DEFAULT_TIMEOUT_MS = 15000;
// Browser-backed lifecycle calls (Chromium cold start + QR generation, browser
// teardown) legitimately take tens of seconds. The default timeout made a
// slow-but-successful start look like a failure.
const BROWSER_OPERATION_TIMEOUT_MS = 120000;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfToken = null;
let unauthorizedHandler = null;

/** The CSRF token for the current owner session (kept in memory only). */
export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' && token !== '' ? token : null;
}

export function getCsrfToken() {
  return csrfToken;
}

/** Register a callback invoked when the server reports the session is gone. */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'ERROR', details = null, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/** Map an HTTP/error code to a message that is safe to show a person. */
function friendlyMessage(status, code, fallback) {
  if (code === 'CSRF_REQUIRED') return 'Your session has expired. Sign in again.';
  if (code === 'RATE_LIMITED') return fallback || 'Too many requests. Wait a moment and try again.';
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return fallback || 'You do not have permission to perform this action.';
  if (status === 404) return fallback || 'The requested item was not found.';
  if (status === 409) return fallback || 'That action conflicts with the current state.';
  if (status === 429) return fallback || 'Too many requests. Wait a moment and try again.';
  if (status === 501) return fallback || 'This operation is not supported by the selected connector.';
  if (status >= 500) return 'The service could not complete the request. Try again shortly.';
  return fallback || 'The request could not be completed.';
}

/** Build a query string, dropping empty values. */
export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * Perform a request and return `{ data, pagination }`.
 * @param {string} path absolute same-origin path
 */
export async function request(path, options = {}) {
  const { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal, skipAuthRedirect = false } = options;
  const upper = method.toUpperCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const forwardAbort = () => controller.abort('caller');
  if (signal) {
    if (signal.aborted) controller.abort('caller');
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  const finalHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (csrfToken && STATE_CHANGING.has(upper)) finalHeaders['X-CSRF-Token'] = csrfToken;

  let response;
  try {
    response = await fetch(path, {
      method: upper,
      headers: finalHeaders,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.reason === 'timeout') {
      throw new ApiError('The request timed out. Check the service and try again.', { code: 'TIMEOUT' });
    }
    throw new ApiError('Could not reach the service. It may be offline.', { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', forwardAbort);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    if (response.status === 401 && !skipAuthRedirect) unauthorizedHandler?.();
    throw new ApiError(friendlyMessage(response.status, error.code, error.message), {
      status: response.status,
      code: error.code ?? `HTTP_${response.status}`,
      details: error.details ?? null,
      requestId: payload?.requestId ?? response.headers.get('x-request-id') ?? null,
    });
  }

  return unwrap(payload);
}

/** Validate the `{ success, data }` envelope before callers trust its shape. */
export function unwrap(payload) {
  if (!payload || typeof payload !== 'object' || payload.success !== true || payload.data === undefined) {
    throw new ApiError('The service returned an unexpected response.', { code: 'INVALID_RESPONSE' });
  }
  return { data: payload.data, pagination: payload.pagination ?? null };
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

export const authApi = {
  login: (apiKey) => request('/api/v1/ui/auth/login', { method: 'POST', body: { apiKey }, skipAuthRedirect: true }),
  session: () => request('/api/v1/ui/auth/session', { skipAuthRedirect: true }),
  logout: () => request('/api/v1/ui/auth/logout', { method: 'POST', skipAuthRedirect: true }),
};

export const healthApi = {
  live: () => request('/health/live', { skipAuthRedirect: true, timeoutMs: 5000 }),
  ready: () => request('/health/ready', { skipAuthRedirect: true, timeoutMs: 5000 }),
};

export const instancesApi = {
  list: ({ limit = 100, cursor } = {}) => request(`/api/v1/instances${buildQuery({ limit, cursor })}`),
  get: (instanceId) => request(`/api/v1/instances/${instanceId}`),
  status: (instanceId) => request(`/api/v1/instances/${instanceId}/status`),
  capabilities: (instanceId) => request(`/api/v1/instances/${instanceId}/capabilities`),
  create: (payload) => request('/api/v1/instances', { method: 'POST', body: payload }),
  remove: (instanceId) => request(`/api/v1/instances/${instanceId}`, { method: 'DELETE' }),
  connectQr: (instanceId) =>
    request(`/api/v1/instances/${instanceId}/connect/qr`, { method: 'POST', body: {}, timeoutMs: BROWSER_OPERATION_TIMEOUT_MS }),
  connectPairingCode: (instanceId, payload) =>
    request(`/api/v1/instances/${instanceId}/connect/pairing-code`, {
      method: 'POST',
      body: payload,
      timeoutMs: BROWSER_OPERATION_TIMEOUT_MS,
    }),
  disconnect: (instanceId, { logout = false } = {}) =>
    request(`/api/v1/instances/${instanceId}/disconnect`, {
      method: 'POST',
      body: { logout },
      timeoutMs: BROWSER_OPERATION_TIMEOUT_MS,
    }),
  session: (instanceId) => request(`/api/v1/instances/${instanceId}/session`),
  revokeSession: (instanceId) => request(`/api/v1/instances/${instanceId}/session`, { method: 'DELETE' }),
  retention: (instanceId) => request(`/api/v1/instances/${instanceId}/retention`),
  updateRetention: (instanceId, payload) =>
    request(`/api/v1/instances/${instanceId}/retention`, { method: 'PUT', body: payload }),
  purge: (instanceId) => request(`/api/v1/instances/${instanceId}/data/purge`, { method: 'POST' }),
  auditEvents: (instanceId, { limit = 50, action } = {}) =>
    request(`/api/v1/instances/${instanceId}/audit-events${buildQuery({ limit, action })}`),
  // Read-only Data API. Every route is capability-aware: a connector that
  // cannot serve one answers 501 CAPABILITY_NOT_SUPPORTED, which the UI states
  // plainly rather than hiding behind empty data.
  chats: (instanceId, { limit = 25, cursor, since, until } = {}) =>
    request(`/api/v1/instances/${instanceId}/chats${buildQuery({ limit, cursor, since, until })}`),
  chat: (instanceId, chatId) => request(`/api/v1/instances/${instanceId}/chats/${encodeURIComponent(chatId)}`),
  messages: (instanceId, chatId, { limit = 25, cursor, direction, since, until } = {}) =>
    request(
      `/api/v1/instances/${instanceId}/chats/${encodeURIComponent(chatId)}/messages${buildQuery({
        limit,
        cursor,
        direction,
        since,
        until,
      })}`,
    ),
  // Instance-wide recorded history (incoming + outgoing). This is the REST
  // counterpart of the live `message.received` / `message.sent` SSE events.
  recordedMessages: (instanceId, { limit = 50, cursor, chatId, direction, since, until } = {}) =>
    request(
      `/api/v1/instances/${instanceId}/messages${buildQuery({ limit, cursor, chatId, direction, since, until })}`,
    ),
  recordedMessage: (instanceId, messageId) =>
    request(`/api/v1/instances/${instanceId}/messages/${encodeURIComponent(messageId)}`),
  contacts: (instanceId, { limit = 25, cursor } = {}) =>
    request(`/api/v1/instances/${instanceId}/contacts${buildQuery({ limit, cursor })}`),
  autoReplies: (instanceId) => request(`/api/v1/instances/${instanceId}/autoreplies`),
  createAutoReply: (instanceId, payload) =>
    request(`/api/v1/instances/${instanceId}/autoreplies`, { method: 'POST', body: payload }),
  updateAutoReply: (instanceId, ruleId, payload) =>
    request(`/api/v1/instances/${instanceId}/autoreplies/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: payload,
    }),
  deleteAutoReply: (instanceId, ruleId) =>
    request(`/api/v1/instances/${instanceId}/autoreplies/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }),
  streamToken: (instanceId) => request(`/api/v1/instances/${instanceId}/auth/stream-token`, { method: 'POST', body: {} }),
  eventsUrl: (instanceId) => `/api/v1/instances/${instanceId}/auth/events`,
};

export const keysApi = {
  list: ({ limit = 100, offset = 0 } = {}) => request(`/api/v1/api-keys${buildQuery({ limit, offset })}`),
  get: (keyId) => request(`/api/v1/api-keys/${encodeURIComponent(keyId)}`),
  create: (payload) => request('/api/v1/api-keys', { method: 'POST', body: payload }),
  rotate: (keyId, payload = {}) => request(`/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`, { method: 'POST', body: payload }),
  revoke: (keyId) => request(`/api/v1/api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),
};

export const connectorsApi = {
  list: () => request('/api/v1/connectors'),
};

export const messagesApi = {
  send: (payload) => request('/api/v1/messages/send', { method: 'POST', body: payload }),
};

export const uiApi = {
  overview: () => request('/api/v1/ui/overview'),
  config: () => request('/api/v1/ui/config'),
  connectors: () => request('/api/v1/ui/connectors'),
  deliveries: ({ instanceId, limit = 50 } = {}) =>
    request(`/api/v1/ui/deliveries${buildQuery({ instanceId, limit })}`),
  auditEvents: ({ limit = 50, offset = 0, action, category, result, instanceId, since, until } = {}) =>
    request(`/api/v1/ui/audit-events${buildQuery({ limit, offset, action, category, result, instanceId, since, until })}`),
};
