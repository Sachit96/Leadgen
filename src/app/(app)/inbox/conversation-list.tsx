'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { InboxFilter, InboxRow } from '@/lib/services/conversations';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import { cn, Badge, Dot } from '@/components/ui/primitives';
import { ScoreBadge } from '@/components/ui/status';

const FILTER_LABELS: Array<{ key: InboxFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'needs_human', label: 'Needs you' },
  { key: 'hot', label: 'Hot' },
  { key: 'booked', label: 'Booked' },
  { key: 'mine', label: 'Mine' },
  { key: 'closed', label: 'Closed' },
];

export function ConversationList() {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();

  const filter = (params.get('filter') ?? 'all') as InboxFilter;
  const search = params.get('q') ?? '';

  const [query, setQuery] = useState(search);
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const url = new URLSearchParams();
    if (filter !== 'all') url.set('filter', filter);
    if (search) url.set('q', search);
    try {
      const response = await fetch(`/api/inbox?${url}`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as { rows: InboxRow[]; total: number };
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Live refresh: when the activity feed reports something new, refetch the
  // list rather than mutating a stale copy client-side.
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('activity', () => {
      void load();
      router.refresh();
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [load, router]);

  useEffect(() => setQuery(search), [search]);

  const selectedId = pathname.startsWith('/inbox/') ? pathname.slice('/inbox/'.length) : null;

  const applyFilter = (next: InboxFilter) => {
    const url = new URLSearchParams(params.toString());
    if (next === 'all') url.delete('filter');
    else url.set('filter', next);
    router.push(`/inbox${url.toString() ? `?${url}` : ''}`);
  };

  const applySearch = (event: React.FormEvent) => {
    event.preventDefault();
    const url = new URLSearchParams(params.toString());
    if (query.trim()) url.set('q', query.trim());
    else url.delete('q');
    router.push(`/inbox${url.toString() ? `?${url}` : ''}`);
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-ink-700 bg-ink-900">
      <div className="border-b border-ink-700 p-3">
        <form onSubmit={applySearch}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="w-full rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-sm placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
          />
        </form>
        <div className="mt-2 flex flex-wrap gap-1">
          {FILTER_LABELS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => applyFilter(item.key)}
              aria-pressed={filter === item.key}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                filter === item.key
                  ? 'bg-accent-600 font-medium text-white'
                  : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-6 text-center text-sm text-ink-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-500">
            No conversations match this view.
          </p>
        ) : (
          <ul>
            {rows.map((row) => {
              const selected = row.id === selectedId;
              const name = row.companyName ?? formatPhone(row.phone);
              return (
                <li key={row.id}>
                  <Link
                    href={`/inbox/${row.id}`}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'block border-b border-ink-800 px-3 py-2.5 transition-colors',
                      selected ? 'bg-ink-800' : 'hover:bg-ink-850',
                      row.requiresHuman && !selected && 'border-l-2 border-l-warning-500',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p
                        className={cn(
                          'truncate text-sm',
                          row.unreadCount > 0 ? 'font-semibold text-ink-100' : 'text-ink-200',
                        )}
                      >
                        {name}
                      </p>
                      <span className="shrink-0 text-[11px] text-ink-500">
                        {formatRelative(row.lastMessageAt)}
                      </span>
                    </div>

                    <p className="mt-0.5 line-clamp-1 text-xs text-ink-400">
                      {row.lastMessageDirection === 'OUTBOUND' ? (
                        <span className="text-ink-500">You: </span>
                      ) : null}
                      {row.lastMessageBody ?? 'No messages yet'}
                    </p>

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {row.requiresHuman ? <Badge tone="warning">needs you</Badge> : null}
                      {row.leadTemperature === 'hot' ? <Badge tone="hot">hot</Badge> : null}
                      {row.unreadCount > 0 ? (
                        <Badge tone="accent">{row.unreadCount} new</Badge>
                      ) : null}
                      <ScoreBadge score={row.score} bucket={row.scoreBucket} />
                      {row.aiEnabled ? (
                        <span title="AI is handling this" className="flex items-center gap-1 text-[10px] text-ink-500">
                          <Dot tone="accent" /> AI
                        </span>
                      ) : (
                        <span title="AI is paused" className="flex items-center gap-1 text-[10px] text-ink-600">
                          <Dot tone="neutral" /> manual
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-ink-700 px-3 py-2 text-[11px] text-ink-500">
        {loading ? 'Loading…' : `${rows.length} of ${total} conversation${total === 1 ? '' : 's'}`}
      </div>
    </aside>
  );
}
