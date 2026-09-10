'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { ProspectRow } from '@/lib/services/contacts';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import { EmptyState, Table, Td, Th, cn, selectClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { buttonClass } from '@/components/ui/button-styles';
import { ProspectStatusBadge, ScoreBadge } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { bulkAssignCampaign, bulkDelete, bulkRescore } from '@/app/actions/prospects';

export function ProspectsTable({
  rows,
  total,
  page,
  pageCount,
  campaigns,
  canWrite,
}: {
  rows: ProspectRow[];
  total: number;
  page: number;
  pageCount: number;
  campaigns: Array<{ id: string; name: string }>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaignId, setCampaignId] = useState('');
  const [pending, startTransition] = useTransition();

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const selectedIds = useMemo(() => [...selected], [selected]);

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulk = (
    fn: (form: FormData) => Promise<{ ok: boolean; error?: string }>,
    extra: Record<string, string> = {},
    successMessage = 'Done',
  ) => {
    const form = new FormData();
    for (const id of selectedIds) form.append('ids', id);
    for (const [key, value] of Object.entries(extra)) form.set(key, value);

    startTransition(async () => {
      const result = await fn(form);
      if (result.ok) {
        toast.push(successMessage, 'success');
        setSelected(new Set());
        router.refresh();
      } else {
        toast.push(result.error ?? 'That did not work', 'error');
      }
    });
  };

  const goToPage = (next: number) => {
    const url = new URLSearchParams(params.toString());
    url.set('page', String(next));
    router.push(`/prospects?${url}`);
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No prospects match these filters"
        description="Import a list, add one by hand, or widen the filters."
        action={
          <div className="flex gap-2">
            <Link href="/prospects/import" className={buttonClass('primary')}>
              Import CSV
            </Link>
            <Link href="/prospects/new" className={buttonClass('secondary')}>
              Add manually
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <div>
      {canWrite && selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent-600/40 bg-accent-600/10 px-3 py-2">
          <span className="text-sm font-medium text-accent-400">
            {selected.size} selected
          </span>

          <select
            aria-label="Campaign to add to"
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className={cn(selectClass, 'w-auto')}
          >
            <option value="">Add to campaign…</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>

          <Button
            size="sm"
            variant="primary"
            disabled={!campaignId || pending}
            onClick={() =>
              runBulk(bulkAssignCampaign, { campaignId }, `Added ${selected.size} to the campaign`)
            }
          >
            Add
          </Button>

          <Button size="sm" disabled={pending} onClick={() => runBulk(bulkRescore, {}, 'Rescored')}>
            Rescore
          </Button>

          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete ${selected.size} prospect(s)? This cannot be undone.`)) return;
              runBulk(bulkDelete, {}, 'Deleted');
            }}
          >
            Delete
          </Button>

          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-ink-400 hover:text-ink-200"
          >
            Clear selection
          </button>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            {canWrite ? (
              <Th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all on this page"
                  className="size-3.5 accent-blue-500"
                />
              </Th>
            ) : null}
            <Th>Company</Th>
            <Th>Contact</Th>
            <Th>Phone</Th>
            <Th>City</Th>
            <Th>Industry</Th>
            <Th align="right">Reviews</Th>
            <Th align="center">Score</Th>
            <Th>Campaign</Th>
            <Th>Status</Th>
            <Th>Last activity</Th>
            <Th>Next action</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={cn('hover:bg-ink-850', selected.has(row.id) && 'bg-ink-800')}>
              {canWrite ? (
                <Td>
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`Select ${row.companyName ?? row.phone}`}
                    className="size-3.5 accent-blue-500"
                  />
                </Td>
              ) : null}
              <Td>
                <Link
                  href={`/prospects/${row.id}`}
                  className="font-medium text-ink-100 hover:text-accent-400"
                >
                  {row.companyName ?? '—'}
                </Link>
              </Td>
              <Td className="text-ink-300">
                {[row.firstName, row.lastName].filter(Boolean).join(' ') || row.companyOwner || '—'}
              </Td>
              <Td className="whitespace-nowrap tabular-nums text-ink-300">
                {formatPhone(row.phone)}
              </Td>
              <Td className="text-ink-400">{row.companyCity ?? '—'}</Td>
              <Td className="text-ink-400">{row.companyIndustry ?? '—'}</Td>
              <Td align="right" className="tabular-nums text-ink-400">
                {row.companyReviews ?? '—'}
                {row.companyRating ? (
                  <span className="ml-1 text-ink-600">({row.companyRating})</span>
                ) : null}
              </Td>
              <Td align="center">
                <ScoreBadge score={row.score} bucket={row.scoreBucket} />
              </Td>
              <Td className="text-ink-400">{row.campaignName ?? '—'}</Td>
              <Td>
                <ProspectStatusBadge status={row.status} />
              </Td>
              {/*
                * A relative time is computed from the clock, so the server's
                * render and the client's rehydration can straddle a minute
                * boundary and disagree ("1m ago" vs "2m ago"). The value is
                * cosmetic and self-correcting, so the mismatch is suppressed
                * rather than the whole tree being thrown away and rebuilt.
                */}
              <Td className="whitespace-nowrap text-ink-500">
                <span suppressHydrationWarning>{formatRelative(row.lastActivityAt)}</span>
              </Td>
              <Td className="text-ink-400">
                <span suppressHydrationWarning>
                  {row.nextAction ?? (row.nextActionAt ? formatRelative(row.nextActionAt) : '—')}
                </span>
              </Td>
              <Td>
                {row.conversationId ? (
                  <Link
                    href={`/inbox/${row.conversationId}`}
                    className="whitespace-nowrap text-xs text-accent-400 hover:underline"
                  >
                    Open chat
                  </Link>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
        <span>
          Page {page} of {pageCount} · {total.toLocaleString()} prospects
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
            Previous
          </Button>
          <Button size="sm" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
