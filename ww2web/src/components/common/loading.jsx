import { Loader2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton.jsx';
import { cn } from '@/lib/utils.js';

export function Spinner({ className, label = 'Loading' }) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center gap-2 text-muted-foreground', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Full-page centred loader used while the session is being validated. */
export function FullPageLoader({ label = 'Loading' }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
      <Spinner className="justify-center" />
      <p className="text-sm text-muted-foreground">{label}…</p>
    </div>
  );
}

/** Placeholder rows for a data table, so layout does not jump while loading. */
export function TableSkeleton({ rows = 5, columns = 4, className }) {
  return (
    <div className={cn('space-y-2 p-4', className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-5', columnIndex === 0 ? 'w-40' : 'flex-1', columnIndex === columns - 1 && 'w-16 flex-none')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 4, className }) {
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-lg border bg-card p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-7 w-20" />
          <Skeleton className="mt-3 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
