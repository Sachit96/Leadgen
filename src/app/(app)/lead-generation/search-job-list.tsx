'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LeadSearchJob } from '@/lib/db/types';
import { ActionButton } from '@/components/ui/action-form';
import { Badge, Card, EmptyState, Meter, cn, type Tone } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { cancelLeadSearchAction, retryLeadSearchAction } from '@/app/actions/lead-generation';

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  QUEUED: 'accent',
  RUNNING: 'accent',
  COMPLETED: 'positive',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

export type RunOutcome = { leads: number; scored: number; averageScore: number; qualified: number };

/**
 * Run status and history.
 *
 * Every number here is counted from rows the pipeline actually wrote — records
 * discovered, sites crawled, leads promoted, duplicates recognised, crawls that
 * failed. Nothing is estimated and nothing is a timer pretending to be
 * progress, so a stage that silently does nothing shows as a zero instead of a
 * plausible number.
 *
 * The list polls only while something is in flight, and stops the moment
 * nothing is running.
 */
export function SearchJobList({
  jobs,
  outcomes,
  canWrite,
}: {
  jobs: LeadSearchJob[];
  outcomes: Record<string, RunOutcome>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const active = jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (tick > 0) router.refresh();
  }, [tick, router]);

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="Define a market on the left and start a scrape. Businesses appear in the lead inbox as the pipeline discovers, crawls and scores them."
      />
    );
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => {
        const outcome = outcomes[job.id];
        const running = job.status === 'QUEUED' || job.status === 'RUNNING';
        const done = job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED';
        // Progress against what discovery actually found, not the number asked for.
        const settled = job.uniqueCount + job.duplicateCount + job.failedCount;

        return (
          <Card key={job.id} className={cn(running && 'border-accent-600/40')}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-100">
                  {job.query} <span className="text-ink-500">in</span> {job.location}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {new Date(job.createdAt).toLocaleString('en-CA')} · via {job.provider} · up to{' '}
                  {job.requestedCount} · {(job.radiusMeters / 1000).toFixed(0)}km
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>
                  {running ? (
                    <>
                      <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-accent-400" />
                      {job.status.toLowerCase()}
                    </>
                  ) : (
                    job.status.toLowerCase()
                  )}
                </Badge>
                {!done && canWrite ? (
                  <ActionButton
                    action={() => cancelLeadSearchAction(job.id)}
                    successMessage="Run stopped — leads already found are kept"
                    className={buttonClass('danger', 'sm')}
                    confirm="Stop this run? Businesses already discovered and crawled are kept."
                  >
                    Stop
                  </ActionButton>
                ) : null}
                {done && canWrite && (job.status !== 'COMPLETED' || job.failedCount > 0) ? (
                  <ActionButton
                    action={() => retryLeadSearchAction(job.id)}
                    successMessage="Retrying what did not finish"
                    className={buttonClass('secondary', 'sm')}
                    title="Re-runs only the stages that failed. Work that succeeded is not repeated."
                  >
                    Retry
                  </ActionButton>
                ) : null}
                <Link
                  href={`/lead-generation/leads?searchJobId=${job.id}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Review leads
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
                label={running ? 'Processing discovered businesses' : 'Processed'}
                value={settled}
                max={Math.max(job.discoveredCount, 1)}
                caption={`of ${job.discoveredCount} discovered`}
                tone={job.status === 'FAILED' ? 'danger' : running ? 'accent' : 'positive'}
              />
            </div>

            <dl className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              <Counter label="Discovered" value={job.discoveredCount} />
              <Counter label="Leads created" value={job.uniqueCount} tone="positive" />
              <Counter label="Duplicates" value={job.duplicateCount} />
              <Counter label="Crawled" value={job.crawledCount} />
              <Counter
                label="Crawl failed"
                value={job.crawlFailedCount}
                tone={job.crawlFailedCount > 0 ? 'warning' : 'neutral'}
              />
              <Counter
                label="Qualified"
                value={outcome?.qualified ?? job.qualifiedCount}
                tone={(outcome?.qualified ?? 0) > 0 ? 'hot' : 'neutral'}
              />
              <Counter
                label="Avg score"
                value={outcome?.averageScore ?? 0}
                tone={(outcome?.averageScore ?? 0) >= 60 ? 'positive' : 'neutral'}
              />
            </dl>

            {job.failedCount > 0 ? (
              <p className="mt-2 text-xs text-ink-500">
                {job.failedCount} record{job.failedCount === 1 ? '' : 's'} could not be processed. Open
                the lead and use the debug panel to see the stage and the error.
              </p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

function Counter({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: Tone }) {
  const colors: Record<Tone, string> = {
    neutral: 'text-ink-200',
    accent: 'text-accent-400',
    positive: 'text-positive-400',
    warning: 'text-warning-400',
    danger: 'text-danger-400',
    hot: 'text-hot-500',
  };
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className={cn('text-sm font-medium tabular-nums', colors[tone])}>{value.toLocaleString()}</dd>
    </div>
  );
}
