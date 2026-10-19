import { Link } from 'react-router-dom';
import { LiveDot } from '@/components/common/status-badge.jsx';
import { useStatus } from '@/hooks/use-status.jsx';
import { cn } from '@/lib/utils.js';

const TONES = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** Derive one honest headline from the instance statuses in the overview. */
function summarise(overview) {
  if (!overview) return { label: 'Checking…', tone: 'muted', active: false };
  const byStatus = overview.connections?.byStatus ?? {};
  const total = overview.connections?.total ?? 0;
  if (total === 0) return { label: 'No instances', tone: 'muted', active: false };

  const ready = byStatus.ready ?? 0;
  const errors = byStatus.error ?? 0;
  const inProgress =
    (byStatus.initializing ?? 0) +
    (byStatus.awaiting_qr ?? 0) +
    (byStatus.awaiting_pairing_code ?? 0) +
    (byStatus.authenticated ?? 0) +
    (byStatus.reconnecting ?? 0);

  if (ready > 0) return { label: `${ready} of ${total} connected`, tone: 'success', active: true };
  if (errors > 0) return { label: `${errors} in error`, tone: 'destructive', active: false };
  if (inProgress > 0) return { label: 'Connecting…', tone: 'warning', active: false };
  return { label: 'Disconnected', tone: 'muted', active: false };
}

export function ConnectionIndicator({ className, showLabel = true }) {
  const { overview, error } = useStatus();
  const summary = error ? { label: 'Status unavailable', tone: 'destructive', active: false } : summarise(overview);

  return (
    <Link
      to="/connection"
      className={cn(
        'inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent',
        TONES[summary.tone],
        className,
      )}
      aria-label={`Connection status: ${summary.label}`}
    >
      <LiveDot active={summary.active} />
      {showLabel ? <span className="whitespace-nowrap">{summary.label}</span> : null}
    </Link>
  );
}
