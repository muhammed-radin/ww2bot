import { NavLink } from 'react-router-dom';
import { NAV_SECTIONS } from '@/components/layout/nav-items.js';
import { cn } from '@/lib/utils.js';

/** Primary navigation list, reused by the sidebar and the mobile drawer. */
export function NavList({ onNavigate, className }) {
  return (
    <nav className={cn('flex flex-col gap-6', className)} aria-label="Primary">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label} className="space-y-1">
          <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.label}</p>
          <ul className="space-y-1">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={onNavigate}
                  title={item.description}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
