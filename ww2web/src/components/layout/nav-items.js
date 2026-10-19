import { BookOpen, Bot, Database, LayoutDashboard, Radio, ScrollText, Send, Server, Settings, ShieldCheck, SlidersHorizontal } from 'lucide-react';

/**
 * Single source of truth for the dashboard navigation, shared by the desktop
 * sidebar and the mobile drawer so the two can never drift apart.
 */
export const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, description: 'Service and connection summary' },
      { to: '/connection', label: 'Connection', icon: Radio, description: 'Sign-in, QR and pairing controls' },
      { to: '/instances', label: 'Instances', icon: Server, description: 'Manage WhatsApp instances' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/messaging', label: 'Messaging', icon: Send, description: 'Outbound activity and test sends' },
      { to: '/autoreplies', label: 'Auto-replies', icon: Bot, description: 'Automatically reply to incoming messages' },
      { to: '/data', label: 'Data', icon: Database, description: 'Read-only chats, messages and contacts' },
      { to: '/logs', label: 'Logs', icon: ScrollText, description: 'Audit trail and request history' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/config', label: 'Configuration', icon: SlidersHorizontal, description: 'Effective service settings' },
      { to: '/security', label: 'Security', icon: ShieldCheck, description: 'API keys and owner access' },
      { to: '/settings', label: 'Settings', icon: Settings, description: 'Your dashboard preferences' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { to: '/docs', label: 'Documentation', icon: BookOpen, description: 'Guides, API reference and operations' },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/**
 * Match the current pathname to a navigation entry. Exact matches win; the
 * longest matching prefix covers nested routes such as `/docs/api-reference`.
 */
export function findNavItem(pathname) {
  if (!pathname) return null;
  const exact = ALL_NAV_ITEMS.find((item) => item.to === pathname);
  if (exact) return exact;

  const nested = ALL_NAV_ITEMS.filter((item) => item.to !== '/' && pathname.startsWith(`${item.to}/`)).sort(
    (a, b) => b.to.length - a.to.length,
  );
  return nested[0] ?? null;
}
