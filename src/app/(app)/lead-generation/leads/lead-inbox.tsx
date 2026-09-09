'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { LeadRow, LeadView } from '@/lib/services/leads';
import { ActionForm } from '@/components/ui/action-form';
import { Button } from '@/components/ui/buttons';
import {
  Badge,
  Card,
  EmptyState,
  Table,
  Td,
  Th,
  cn,
  inputClass,
  selectClass,
  type Tone,
} from '@/components/ui/primitives';
import { ScoreBadge } from '@/components/ui/status';
import { buttonClass } from '@/components/ui/button-styles';
import { approveLeadsAction, rejectLeadsAction } from '@/app/actions/lead-generation';
import { addToCallQueueAction } from '@/app/actions/calls';
import { bulkAssignCampaign } from '@/app/actions/prospects';

const READINESS_TONE: Record<string, Tone> = {
  READY: 'positive',
  QUEUED: 'accent',
  CALLED: 'accent',
  CALLBACK: 'warning',
  COMPLETED: 'neutral',
  NOT_READY: 'neutral',
};

export function LeadInbox({
  views,
  activeView,
  rows,
  total,
  page,
  pageCount,
  industries,
  cities,
  queues,
  campaigns,
  canWrite,
}: {
  views: Array<{ key: LeadView; label: string; count: number }>;
  activeView: LeadView;
  rows: LeadRow[];
  total: number;
  page: number;
  pageCount: number;
  industries: string[];
  cities: string[];
  queues: Array<{ id: string; name: string }>;
  campaigns: Array<{ id: string; name: string }>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectedIds = useMemo(() => [...selected], [selected]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.contactId));

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    // Any change to the filters invalidates the page number.
    if (key !== 'page') next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Lead views">
        {views.map((view) => (
          <button
            key={view.key}
            type="button"
            role="tab"
            aria-selected={view.key === activeView}
            onClick={() => setParam('view', view.key === 'ALL' ? null : view.key)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
              view.key === activeView
                ? 'border-accent-600/50 bg-accent-600/15 text-accent-400'
                : 'border-ink-700 bg-ink-850 text-ink-400 hover:border-ink-600 hover:text-ink-200',
            )}
          >
            {view.label}
            <span className="ml-1.5 tabular-nums text-ink-500">{view.count}</span>
          </button>
        ))}
      </div>

      <Card className="mb-4" padded>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[180px]">
            <span className="mb-1 block text-xs font-medium text-ink-300">Search</span>
            <input
              className={inputClass}
              defaultValue={params.get('q') ?? ''}
              placeholder="Business, phone or city"
              onKeyDown={(event) => {
                if (event.key === 'Enter') setParam('q', event.currentTarget.value);
              }}
            />
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-ink-300">Industry</span>
            <select
              className={selectClass}
              defaultValue={params.get('industry') ?? ''}
              onChange={(e) => setParam('industry', e.target.value)}
            >
              <option value="">Any</option>
              {industries.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-ink-300">City</span>
            <select
              className={selectClass}
              defaultValue={params.get('city') ?? ''}
              onChange={(e) => setParam('city', e.target.value)}
            >
              <option value="">Any</option>
              {cities.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-ink-300">Min score</span>
            <input
              type="number"
              min={0}
              max={100}
              className={`${inputClass} w-24`}
              defaultValue={params.get('minScore') ?? ''}
              onBlur={(e) => setParam('minScore', e.target.value)}
            />
          </label>

          {params.get('searchJobId') ? (
            <Button variant="ghost" size="sm" onClick={() => setParam('searchJobId', null)}>
              Clear search filter
            </Button>
          ) : null}
        </div>
      </Card>

      {selectedIds.length > 0 && canWrite ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent-600/40 bg-accent-600/10 px-3 py-2">
          <span className="text-xs font-medium text-accent-300">
            {selectedIds.length} selected
          </span>

          <ActionForm
            action={approveLeadsAction}
            successMessage="Approved"
            onSuccess={() => setSelected(new Set())}
            className="contents"
          >
            {selectedIds.map((id) => (
              <input key={id} type="hidden" name="contactId" value={id} />
            ))}
            <Button type="submit" variant="primary" size="sm">
              Approve
            </Button>
          </ActionForm>

          <ActionForm
            action={rejectLeadsAction}
            successMessage="Rejected — the records stay in the CRM"
            onSuccess={() => setSelected(new Set())}
            className="flex items-center gap-2"
          >
            {selectedIds.map((id) => (
              <input key={id} type="hidden" name="contactId" value={id} />
            ))}
            <input name="reason" placeholder="Reason (optional)" className={`${inputClass} h-7 w-44 text-xs`} />
            <Button type="submit" variant="danger" size="sm">
              Reject
            </Button>
          </ActionForm>

          {queues.length > 0 ? (
            <ActionForm
              action={addToCallQueueAction}
              successMessage="Added to the queue"
              onSuccess={() => setSelected(new Set())}
              className="flex items-center gap-2"
            >
              {selectedIds.map((id) => (
                <input key={id} type="hidden" name="contactId" value={id} />
              ))}
              <select name="queueId" className={`${selectClass} h-7 py-0 text-xs`}>
                {queues.map((q) => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </select>
              <Button type="submit" variant="secondary" size="sm">
                Add to call queue
              </Button>
            </ActionForm>
          ) : null}

          {campaigns.length > 0 ? (
            <ActionForm
              action={bulkAssignCampaign}
              successMessage="Enrolled — suppressed and already-enrolled prospects were skipped"
              onSuccess={() => setSelected(new Set())}
              className="flex items-center gap-2"
            >
              {selectedIds.map((id) => (
                <input key={id} type="hidden" name="ids" value={id} />
              ))}
              <select name="campaignId" className={`${selectClass} h-7 py-0 text-xs`}>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <Button type="submit" variant="secondary" size="sm">
                Add to campaign
              </Button>
            </ActionForm>
          ) : null}

          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing in this view"
          description="Run a search, or widen the filters. Leads appear here as the worker enriches them."
          action={
            <Link href="/lead-generation" className={buttonClass('primary')}>
              Run a search
            </Link>
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.contactId)))
                  }
                  className="size-3.5 rounded border-ink-600 bg-ink-900 accent-accent-600"
                />
              </Th>
              <Th>Business</Th>
              <Th>Category</Th>
              <Th>City</Th>
              <Th>Phone</Th>
              <Th align="right">Reviews</Th>
              <Th align="right">Score</Th>
              <Th align="right">Complete</Th>
              <Th>Stage</Th>
              <Th>Call</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.contactId} className="hover:bg-ink-850">
                <Td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.companyName ?? row.phone}`}
                    checked={selected.has(row.contactId)}
                    onChange={() => toggle(row.contactId)}
                    className="size-3.5 rounded border-ink-600 bg-ink-900 accent-accent-600"
                  />
                </Td>
                <Td>
                  <Link
                    href={`/lead-generation/leads/${row.contactId}`}
                    className="font-medium text-ink-100 hover:text-accent-400"
                  >
                    {row.companyName ?? row.contactName ?? 'Unnamed'}
                  </Link>
                  {row.isDemo ? <Badge className="ml-1.5">demo</Badge> : null}
                  {row.hasPersonalization ? (
                    <span title="Has an opening line" className="ml-1.5 text-[10px] text-accent-400">
                      ✎
                    </span>
                  ) : null}
                </Td>
                <Td className="text-ink-400">{row.category ?? '—'}</Td>
                <Td className="text-ink-400">{row.city ?? '—'}</Td>
                <Td className="tabular-nums text-ink-300">{row.phone}</Td>
                <Td align="right" className="tabular-nums text-ink-400">
                  {row.reviews ?? '—'}
                </Td>
                <Td align="right">
                  <ScoreBadge score={row.score} bucket={row.scoreBucket} />
                </Td>
                <Td align="right" className="tabular-nums text-ink-400">
                  {row.completeness === null ? '—' : `${row.completeness}%`}
                </Td>
                <Td>
                  <span className="text-xs text-ink-400">{(row.stage ?? '—').toLowerCase()}</span>
                </Td>
                <Td>
                  <Badge tone={READINESS_TONE[row.callReadiness] ?? 'neutral'}>
                    {row.callReadiness.replace('_', ' ').toLowerCase()}
                  </Badge>
                </Td>
                <Td align="right">
                  <Link
                    href={`/prospects/${row.contactId}`}
                    className="text-xs text-ink-500 hover:text-ink-200"
                  >
                    CRM
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {pageCount > 1 ? (
        <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
          <span>
            Page {page} of {pageCount} · {total.toLocaleString()} leads
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam('page', String(page - 1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setParam('page', String(page + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
