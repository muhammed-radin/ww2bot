/**
 * Connection state machine.
 *
 * These are the states the gateway tracks and persists for every instance. They
 * are deliberately explicit so recovery behaviour is predictable and every
 * transition can be logged and emitted as an event.
 */
export const ConnectionState = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  INITIALIZING: 'INITIALIZING',
  QR_REQUIRED: 'QR_REQUIRED',
  AUTHENTICATING: 'AUTHENTICATING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
});

/** States from which an automatic reconnect is meaningful after a restart. */
export const LIVE_STATES = Object.freeze([
  ConnectionState.INITIALIZING,
  ConnectionState.QR_REQUIRED,
  ConnectionState.AUTHENTICATING,
  ConnectionState.CONNECTED,
  ConnectionState.RECONNECTING,
]);

/** Map a connector-reported status onto a state machine state. */
export function mapConnectorStatus(status) {
  switch (status) {
    case 'ready':
      return ConnectionState.CONNECTED;
    case 'authenticated':
      return ConnectionState.AUTHENTICATING;
    case 'awaiting_qr':
      return ConnectionState.QR_REQUIRED;
    case 'awaiting_pairing_code':
      return ConnectionState.AUTHENTICATING;
    case 'initializing':
      return ConnectionState.INITIALIZING;
    case 'error':
      return ConnectionState.ERROR;
    case 'destroyed':
    case 'disconnected':
    case 'created':
      return ConnectionState.DISCONNECTED;
    default:
      return ConnectionState.INITIALIZING;
  }
}

/**
 * Exponential backoff with full-ish jitter.
 * @param {number} attempt 1-based attempt number
 * @param {{baseDelayMs:number, maxDelayMs:number, jitter:number}} policy
 * @returns {number} delay in milliseconds
 */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitter }) {
  const exponential = Math.min(baseDelayMs * 2 ** Math.max(attempt - 1, 0), maxDelayMs);
  if (!jitter || jitter <= 0) return exponential;
  const spread = exponential * jitter;
  // Random in [exponential - spread, exponential + spread], clamped at zero.
  const delay = exponential - spread + Math.random() * spread * 2;
  return Math.max(Math.round(delay), 1);
}
