import { cn } from '@/lib/utils.js';

/**
 * Page title block. `eyebrow` carries the breadcrumb-ish context, and `actions`
 * holds primary controls that stay aligned on mobile too.
 */
export function PageHeader({ title, description, actions, eyebrow, className }) {
  return (
    <header className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
