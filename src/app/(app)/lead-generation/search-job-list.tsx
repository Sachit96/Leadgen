'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LeadSearchJob } from '@/lib/db/types';
import { ActionButton } from '@/components/ui/action-form';
import { Badge, Card, EmptyState, Meter, type Tone } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { cancelLeadSearchAction } from '@/app/actions/lead-generation';

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  QUEUED: 'accent',
  RUNNING: 'accent',
  COMPLETED: 'positive',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

/**
 * Live search progress.
 *
 * Counts come from the server on a refresh interval while anything is in
 * flight, and stop the moment nothing is running — the bar tracks records the
 * pipeline has actually written, never a timer pretending to be progress.
 */
export function SearchJobList({ jobs, canWrite }: { jobs: LeadSearchJob[]; canWrite: boolean }) {
  const router = useRouter();
  const active = jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (tick > 0) router.refresh();
  }, [tick, router]);

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No searches yet"
        description="Run one from the form on the left. Results land in the lead inbox as the worker enriches them."
      />
    );
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => {
        const processed =
          job.uniqueCount + job.duplicateCount + job.failedCount;
        const done = job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED';

        return (
          <Card key={job.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-100">
                  {job.query} <span className="text-ink-500">in</span> {job.location}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {new Date(job.createdAt).toLocaleString('en-CA')} · via {job.provider} · asked for{' '}
                  {job.requestedCount}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>{job.status.toLowerCase()}</Badge>
                {!done && canWrite ? (
                  <ActionButton
                    action={() => cancelLeadSearchAction(job.id)}
                    successMessage="Search cancelled"
                    className={buttonClass('ghost', 'sm')}
                    confirm="Cancel this search? Leads already found are kept."
                  >
                    Cancel
                  </ActionButton>
                ) : null}
                <Link
                  href={`/lead-generation/leads?searchJobId=${job.id}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  View leads
                </Link>
              </div>
            </div>

            {job.error ? (
              <p className="mt-2 rounded border border-danger-500/40 bg-danger-500/10 px-2 py-1.5 text-xs text-danger-400">
                {job.error}
              </p>
            ) : null}

            <div className="mt-3">
              <Meter
                label="Discovered and processed"
                value={processed}
                max={Math.max(job.discoveredCount, 1)}
                caption={`of ${job.discoveredCount} found`}
                tone={job.status === 'FAILED' ? 'danger' : 'accent'}
              />
            </div>

            <dl className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Counter label="Unique" value={job.uniqueCount} />
              <Counter label="Duplicate" value={job.duplicateCount} />
              <Counter label="Enriched" value={job.enrichedCount} />
              <Counter label="Researched" value={job.researchedCount} />
              <Counter label="Scored" value={job.scoredCount} />
              <Counter label="Failed" value={job.failedCount} tone={job.failedCount > 0 ? 'danger' : 'neutral'} />
            </dl>
          </Card>
        );
      })}
    </div>
  );
}

function Counter({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: Tone }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd
        className={
          tone === 'danger'
            ? 'text-sm font-medium tabular-nums text-danger-400'
            : 'text-sm font-medium tabular-nums text-ink-200'
        }
      >
        {value}
      </dd>
    </div>
  );
}
