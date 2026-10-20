/**
 * Presentation helpers: date/time formatting and status vocabulary.
 *
 * Status mapping is honest: the strings the backend uses are translated to
 * human labels, but the underlying value is never overstated (for example
 * "accepted" is never displayed as "delivered").
 */

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const timeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '—';
  return dateTimeFormatter.format(date);
}

export function formatTime(value) {
  const date = toDate(value);
  if (!date) return '—';
  return timeFormatter.format(date);
}

export function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Compact relative time such as "4 min ago", falling back to a date. */
export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return '—';
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  const suffix = future ? 'from now' : 'ago';
  if (seconds < 45) return future ? 'in a moment' : 'just now';
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secondsInUnit] of units) {
    if (seconds >= secondsInUnit) {
      const count = Math.floor(seconds / secondsInUnit);
      return `${count} ${unit}${count === 1 ? '' : 's'} ${suffix}`;
    }
  }
  return `${seconds}s ${suffix}`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—';
  const total = Math.max(Math.round(Number(ms) / 1000), 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours) parts.push(`${seconds}s`);
  return parts.slice(0, 2).join(' ');
}

/** Truncate an identifier for display while keeping both ends recognisable. */
export function shortId(id, { head = 10, tail = 6 } = {}) {
  if (typeof id !== 'string' || id.length === 0) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function formatCount(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat().format(value);
}

const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/** Compact file size (binary units, like the browser's own UI). */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** "3:42 PM" for message bubbles and chat-list timestamps. */
export function formatClock(value) {
  const date = toDate(value);
  if (!date) return '';
  return clockFormatter.format(date);
}

/** A friendly day separator: Today / Yesterday / Monday, 3 June 2025. */
export function formatDay(value) {
  const date = toDate(value);
  if (!date) return '';
  const now = new Date();
  const startOf = (input) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const difference = Math.round((startOf(now) - startOf(date)) / 86400000);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return dayFormatter.format(date);
}

/** Seconds → m:ss (voice notes, call durations). */
export function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* status vocabulary                                                   */
/* ------------------------------------------------------------------ */

/**
 * Instance/connection status -> presentation.
 * `tone` maps to a Badge variant; `label` is what a person reads.
 */
export const CONNECTION_STATES = Object.freeze({
  CONNECTED: { label: 'Connected', tone: 'success' },
  AUTHENTICATING: { label: 'Authenticating', tone: 'info' },
  QR_REQUIRED: { label: 'QR required', tone: 'warning' },
  INITIALIZING: { label: 'Connecting', tone: 'info' },
  RECONNECTING: { label: 'Reconnecting', tone: 'warning' },
  DISCONNECTED: { label: 'Disconnected', tone: 'muted' },
  ERROR: { label: 'Error', tone: 'destructive' },
});

/** Instance status (from the instance record) -> presentation. */
export const INSTANCE_STATUSES = Object.freeze({
  created: { label: 'Created', tone: 'muted' },
  initializing: { label: 'Connecting', tone: 'info' },
  awaiting_qr: { label: 'QR required', tone: 'warning' },
  awaiting_pairing_code: { label: 'Pairing code', tone: 'warning' },
  authenticated: { label: 'Authenticated', tone: 'info' },
  ready: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  disconnected: { label: 'Disconnected', tone: 'muted' },
  error: { label: 'Error', tone: 'destructive' },
  destroyed: { label: 'Destroyed', tone: 'muted' },
});

/** Delivery status -> presentation. Accepted ≠ delivered; the wording keeps that clear. */
export const DELIVERY_STATUSES = Object.freeze({
  accepted: { label: 'Accepted', tone: 'info', hint: 'Accepted by the provider; handset delivery is not confirmed.' },
  sent: { label: 'Sent', tone: 'success', hint: 'Handed to WhatsApp by the linked device.' },
  pending: { label: 'Pending', tone: 'warning', hint: 'Still in progress.' },
  failed: { label: 'Failed', tone: 'destructive', hint: 'The provider rejected the send.' },
  unknown: { label: 'Unknown', tone: 'muted', hint: 'The provider did not report a definitive status.' },
});

export function instanceStatus(status) {
  return INSTANCE_STATUSES[status] ?? { label: status ?? 'Unknown', tone: 'muted' };
}

export function connectionState(state, fallbackStatus) {
  if (state && CONNECTION_STATES[state]) return CONNECTION_STATES[state];
  return instanceStatus(fallbackStatus);
}

export function deliveryStatus(status) {
  return DELIVERY_STATUSES[status] ?? { label: status ?? 'Unknown', tone: 'muted' };
}

export function auditResult(result) {
  if (result === 'success') return { label: 'Success', tone: 'success' };
  if (result === 'failure') return { label: 'Failure', tone: 'destructive' };
  return { label: result ?? 'Unknown', tone: 'muted' };
}

/** Map an audit action to a broad category for the Logs page. */
export function auditCategory(action) {
  const value = String(action ?? '');
  if (value.startsWith('auth.') || value.startsWith('owner.') || value.startsWith('api_key.')) return 'authentication';
  if (value.startsWith('session.')) return 'connection';
  if (
    value.startsWith('instance.connect') ||
    value.startsWith('instance.connected') ||
    value.startsWith('instance.disconnected') ||
    value.startsWith('instance.reconnected') ||
    value.startsWith('instance.logged_out') ||
    value.startsWith('instance.session_revoked') ||
    value.startsWith('connection.')
  ) {
    return 'connection';
  }
  if (value.startsWith('instance.created') || value.startsWith('instance.deleted') || value.startsWith('instance.retention')) {
    return 'configuration';
  }
  if (value.startsWith('message.')) return 'messaging';
  return 'other';
}

export function titleCase(value) {
  return String(value ?? '')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
