import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { cn } from '@/lib/utils.js';

const TONES = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-primary',
  muted: 'text-muted-foreground',
};

/** Compact metric tile used across the dashboard. */
export function StatCard({ label, value, hint, icon: Icon, tone = 'default', className, children }) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 p-4 pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
        {Icon ? <Icon className={cn('size-4', TONES[tone] ?? TONES.default)} aria-hidden="true" /> : null}
      </CardHeader>
      <CardContent className="space-y-1 p-4 pt-0">
        <div className={cn('text-2xl font-semibold tabular-nums', TONES[tone] ?? TONES.default)}>{value}</div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {children}
      </CardContent>
    </Card>
  );
}
