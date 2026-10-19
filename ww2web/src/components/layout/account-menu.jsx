import { useNavigate } from 'react-router-dom';
import { ChevronsUpDown, LogOut, Settings, ShieldCheck, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.jsx';
import { useAuth } from '@/hooks/use-auth.jsx';
import { shortId } from '@/lib/format.js';
import { cn } from '@/lib/utils.js';

export function AccountMenu({ align = 'end', className, compact = false }) {
  const { owner, logout } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-auto w-full justify-start gap-2 px-2 py-1.5 data-[state=open]:bg-sidebar-accent',
            compact && 'justify-center px-0',
            className,
          )}
          aria-label="Owner account menu"
        >
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted">
            <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          {compact ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                <span className="truncate text-sm font-medium">{owner?.name ?? 'Owner'}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{shortId(owner?.keyId, { head: 8, tail: 4 })}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{owner?.name ?? 'Owner session'}</span>
            <span className="font-mono text-xs text-muted-foreground">{owner?.keyId ? shortId(owner.keyId) : '—'}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="opacity-100">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">
            {owner?.scopes?.length ? `${owner.scopes.length} scopes` : 'Owner access'}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings className="size-4" aria-hidden="true" />
          Dashboard settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleSignOut} className="text-destructive focus:text-destructive">
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
