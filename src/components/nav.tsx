'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from './ui/primitives';

export type NavCounts = { inbox: number; needsHuman: number; tasks: number };

const ITEMS = [
  { href: '/', label: 'Today', icon: 'today' },
  { href: '/radar', label: 'Control Room', icon: 'radar' },
  { href: '/calls', label: 'Calls', icon: 'calls' },
  { href: '/inbox', label: 'Inbox', icon: 'inbox', badge: 'inbox' as const },
  { href: '/prospects', label: 'Prospects', icon: 'prospects' },
  { href: '/lead-generation', label: 'Lead generation', icon: 'leadgen' },
  { href: '/campaigns', label: 'Campaigns', icon: 'campaigns' },
  { href: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar' },
  { href: '/analytics', label: 'Analytics', icon: 'analytics' },
  { href: '/ai', label: 'AI', icon: 'ai' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

export function Nav({
  counts,
  organizationName,
  userName,
  userRole,
}: {
  counts: NavCounts;
  organizationName: string;
  userName: string;
  userRole: string;
}) {
  const pathname = usePathname();
  const [live, setLive] = useState(counts);

  // The badge counts follow the same SSE feed the inbox uses, so a reply that
  // arrives while you are on another screen still shows up.
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('counts', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { unread: number; needsHuman: number };
        setLive((current) => ({ ...current, inbox: data.unread, needsHuman: data.needsHuman }));
      } catch {
        // Malformed frame; keep the last known counts.
      }
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, []);

  return (
    <nav
      aria-label="Main"
      className="flex h-full w-52 shrink-0 flex-col border-r border-ink-700 bg-ink-950"
    >
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
        <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0 text-accent-400" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        </svg>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-ink-100">On Radar</p>
          <p className="truncate text-[11px] text-ink-500">{organizationName}</p>
        </div>
      </div>

      <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {ITEMS.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const count = item.badge === 'inbox' ? live.inbox : 0;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-ink-800 font-medium text-ink-100'
                    : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200',
                )}
              >
                <NavIcon name={item.icon} active={active} />
                <span className="flex-1">{item.label}</span>
                {count > 0 ? (
                  <span className="rounded bg-accent-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                    {count > 99 ? '99+' : count}
                  </span>
                ) : null}
                {item.badge === 'inbox' && live.needsHuman > 0 ? (
                  <span
                    title={`${live.needsHuman} waiting on a human`}
                    className="size-1.5 rounded-full bg-warning-500"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-ink-700 p-3">
        <p className="truncate text-xs font-medium text-ink-200">{userName}</p>
        <p className="truncate text-[11px] text-ink-500">{userRole.replace('_', ' ').toLowerCase()}</p>
        <form action="/api/logout" method="post" className="mt-2">
          <button
            type="submit"
            className="w-full rounded border border-ink-700 px-2 py-1 text-left text-xs text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200"
          >
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}

function NavIcon({ name, active }: { name: string; active: boolean }) {
  const cls = cn('size-4 shrink-0', active ? 'text-accent-400' : 'text-ink-500');
  const paths: Record<string, React.ReactNode> = {
    today: <path d="M4 6h16M4 12h10M4 18h6" strokeLinecap="round" />,
    inbox: <path d="M3 12h4l2 3h6l2-3h4M3 12V6a2 2 0 012-2h14a2 2 0 012 2v6m-18 0v6a2 2 0 002 2h14a2 2 0 002-2v-6" />,
    radar: <path d="M12 3a9 9 0 109 9M12 12l6.5-6.5M12 12a4.5 4.5 0 104.5 4.5" strokeLinecap="round" />,
    calls: <path d="M4 5a2 2 0 012-2h2.2a1 1 0 01.97.76l.9 3.6a1 1 0 01-.5 1.12l-1.7.85a12 12 0 006 6l.85-1.7a1 1 0 011.12-.5l3.6.9a1 1 0 01.76.97V17a2 2 0 01-2 2h-1C10.4 19 4 12.6 4 6V5z" strokeLinejoin="round" />,
    leadgen: <path d="M11 4a7 7 0 100 14 7 7 0 000-14zm5 12l4 4" strokeLinecap="round" />,
    prospects: <path d="M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 7a3 3 0 100 6 3 3 0 000-6zm13 12v-1a4 4 0 00-3-3.87M16 4.13A4 4 0 0119 8" strokeLinecap="round" />,
    campaigns: <path d="M3 10v4h3l5 4V6L6 10H3zm13-2a5 5 0 010 8m2.5-11a9 9 0 010 14" strokeLinecap="round" />,
    pipeline: <path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v5h-4z" />,
    calendar: <path d="M4 7a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7zM4 10h16M8 3v4M16 3v4" strokeLinecap="round" />,
    analytics: <path d="M4 19V9m5 10V5m5 14v-7m5 7V8" strokeLinecap="round" />,
    ai: <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3zM18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9L18 16z" strokeLinejoin="round" />,
    settings: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 00-1.7-1L14.8 3H9.2l-.4 2.6a7.5 7.5 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 001.7 1l.4 2.4h5.6l.4-2.6a7.5 7.5 0 001.7-1l2.4 1 2-3.4-2-1.6c.06-.33.1-.66.1-1z" strokeLinejoin="round" />,
  };

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={cls} aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
