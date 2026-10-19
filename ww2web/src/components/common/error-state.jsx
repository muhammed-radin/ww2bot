import { AlertTriangle, RotateCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Button } from '@/components/ui/button.jsx';
import { cn } from '@/lib/utils.js';

/** Friendly failure panel. Never renders internal details, only safe messages. */
export function ErrorState({ error, title = 'Something went wrong', onRetry, className }) {
  const message = error?.message ?? 'The request could not be completed.';
  return (
    <Alert variant="destructive" className={cn('items-start', className)}>
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{message}</span>
        {error?.requestId ? (
          <span className="font-mono text-xs text-muted-foreground">Request {error.requestId}</span>
        ) : null}
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onRetry()}>
            <RotateCw className="size-4" aria-hidden="true" />
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
