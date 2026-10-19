import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@/hooks/use-theme.jsx';

/** App-wide notifications, themed to match the dashboard. */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      theme={resolvedTheme}
      position="top-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: 'rounded-lg border bg-card text-card-foreground text-sm',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}
