import { Outlet, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip.jsx';
import { ErrorBoundary } from '@/components/common/error-boundary.jsx';
import { SidebarNav } from '@/components/layout/sidebar-nav.jsx';
import { Topbar } from '@/components/layout/topbar.jsx';
import { StatusProvider } from '@/hooks/use-status.jsx';

/** Authenticated shell: sidebar + topbar + routed page content. */
export function AppLayout() {
  const { pathname } = useLocation();

  return (
    <StatusProvider>
      <TooltipProvider delayDuration={200}>
        <div className="flex min-h-screen w-full bg-background">
          <SidebarNav />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar />
            <main className="flex-1 px-3 py-5 sm:px-5 sm:py-6">
              <div className="mx-auto w-full max-w-6xl">
                <ErrorBoundary key={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </div>
            </main>
            <footer className="border-t px-3 py-4 text-xs text-muted-foreground sm:px-5">
              Single-owner WhatsApp administration. Actions are recorded in the audit trail.
            </footer>
          </div>
        </div>
      </TooltipProvider>
    </StatusProvider>
  );
}
