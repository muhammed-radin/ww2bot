import { Badge } from '@/components/ui/badge.jsx';
import { auditResult, connectionState, deliveryStatus, instanceStatus, titleCase } from '@/lib/format.js';
import { cn } from '@/lib/utils.js';

const RESOLVERS = {
  instance: (value) => instanceStatus(value),
  connection: (value) => connectionState(value),
  delivery: (value) => deliveryStatus(value),
  result: (value) => auditResult(value),
  generic: (value) => ({ label: titleCase(value ?? 'Unknown'), tone: 'muted' }),
};

export function StatusBadge({ status, kind = 'instance', className, children }) {
  const resolver = RESOLVERS[kind] ?? RESOLVERS.generic;
  const meta = resolver(status);
  return (
    <Badge variant={meta.tone} className={cn(className)}>
      {children ?? meta.label}
    </Badge>
  );
}

/** A small pulsing dot used to signal a live stream or an active connection. */
export function LiveDot({ active = false, className, label }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden={label ? undefined : true}>
      {active ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
      ) : null}
      <span className={cn('relative inline-flex size-2 rounded-full', active ? 'bg-success' : 'bg-muted-foreground/50')} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
