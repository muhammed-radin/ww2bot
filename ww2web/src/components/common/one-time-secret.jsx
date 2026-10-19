import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { CopyButton } from '@/components/common/copy-button.jsx';
import { cn } from '@/lib/utils.js';

/**
 * One-time display of a freshly created or rotated API key.
 *
 * The gateway returns the plaintext exactly once. This component makes that
 * explicit, offers a copy action, and never persists the value anywhere.
 */
export function OneTimeSecret({ value, title = 'Copy this key now', description, className }) {
  if (!value) return null;
  return (
    <Alert variant="warning" className={cn('items-start', className)}>
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{description ?? 'This value is shown once and cannot be retrieved later. Store it in your secret manager.'}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 font-mono text-xs">{value}</code>
          <CopyButton value={value} label="Copy key" variant="outline" className="shrink-0" />
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Small "configured / not configured" indicator that never reveals a value. */
export function SecretStatus({ configured, configuredLabel = 'Configured', missingLabel = 'Not configured', className }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', configured ? 'text-foreground' : 'text-muted-foreground', className)}>
      {configured ? <ShieldCheck className="size-4 text-success" aria-hidden="true" /> : <AlertTriangle className="size-4 text-warning" aria-hidden="true" />}
      {configured ? configuredLabel : missingLabel}
    </span>
  );
}
