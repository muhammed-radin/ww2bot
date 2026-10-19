import { useLocation } from 'react-router-dom';
import { ThemeToggle } from '@/components/common/theme-toggle.jsx';
import { AccountMenu } from '@/components/layout/account-menu.jsx';
import { MobileNav } from '@/components/layout/mobile-nav.jsx';
import { findNavItem } from '@/components/layout/nav-items.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';

export function Topbar() {
  const { pathname } = useLocation();
  const item = findNavItem(pathname);
  useDocumentTitle(item?.label ?? 'Dashboard');

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-5">
      <MobileNav />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{item?.label ?? 'ww2web'}</p>
        {item?.description ? <p className="hidden truncate text-xs text-muted-foreground sm:block">{item.description}</p> : null}
      </div>
      <ThemeToggle />
      <div className="lg:hidden">
        <AccountMenu compact />
      </div>
    </header>
  );
}
