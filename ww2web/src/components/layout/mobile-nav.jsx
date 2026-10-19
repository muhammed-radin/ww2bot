import { useState } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet.jsx';
import { Brand } from '@/components/common/brand.jsx';
import { AccountMenu } from '@/components/layout/account-menu.jsx';
import { ConnectionIndicator } from '@/components/layout/connection-indicator.jsx';
import { NavList } from '@/components/layout/nav-list.jsx';

/** Navigation drawer for mobile viewports. */
export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col p-0">
        <SheetHeader className="border-b border-sidebar-border p-4">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Brand />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          <ConnectionIndicator className="w-full justify-center" />
          <NavList onNavigate={() => setOpen(false)} />
        </div>
        <div className="border-t border-sidebar-border p-2">
          <AccountMenu align="start" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
