import { cn } from '@/lib/utils.js';

/** Product mark: a small monogram tile plus wordmark. */
export function Brand({ compact = false, className }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <svg viewBox="0 0 32 32" className="size-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 9l3 9 3-6 3 6 3-9" />
          <path d="M22 11h5M22 15h5" />
        </svg>
      </span>
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">ww2web</span>
          <span className="text-xs text-muted-foreground">WhatsApp administration</span>
        </span>
      )}
    </span>
  );
}
