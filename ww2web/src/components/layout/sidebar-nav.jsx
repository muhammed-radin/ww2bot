import { Brand } from '@/components/common/brand.jsx';
import { ConnectionIndicator } from '@/components/layout/connection-indicator.jsx';
import { AccountMenu } from '@/components/layout/account-menu.jsx';
import { NavList } from '@/components/layout/nav-list.jsx';

/** Fixed sidebar for desktop viewports. */
export function SidebarNav() {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:flex lg:flex-col">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Brand />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <ConnectionIndicator className="w-full justify-center" />
        <NavList />
      </div>
      <div className="border-t border-sidebar-border p-2">
        <AccountMenu align="start" />
      </div>
    </aside>
  );
}
