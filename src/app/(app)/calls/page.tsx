import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { listCallQueues } from '@/lib/services/call-queue';
import { callMetrics } from '@/lib/services/calls';
import { leadViewCounts } from '@/lib/services/leads';
import { listIndustries } from '@/lib/services/companies';
import { listCities } from '@/lib/services/contacts';
import { getCallProvider } from '@/lib/providers/call';
import { daysAgo } from '@/lib/core/time';
import { Card, EmptyState, Meter, PageHeader, SectionTitle, Stat } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { QueueForm } from './queue-form';
import { QueueList } from './queue-list';

export const dynamic = 'force-dynamic';

export default async function CallsPage() {
  const ctx = await requireCtx('prospect:read');
  const provider = getCallProvider();

  const [queues, metrics, counts, industries, cities] = await Promise.all([
    listCallQueues(ctx),
    callMetrics(ctx, daysAgo(7)),
    leadViewCounts(ctx),
    listIndustries(ctx),
    listCities(ctx),
  ]);

  const callReady = counts.CALL_READY ?? 0;
  const active = queues.filter((q) => q.queue.status === 'ACTIVE');

  return (
    <div className="p-6">
      <PageHeader
        title="Calls"
        subtitle="Work a queue one lead at a time. Every outcome is what you marked, not what the phone told us."
        actions={
          <>
            <Link href="/calls/today" className={buttonClass('secondary')}>
              Today
            </Link>
            <Link href="/lead-generation/leads?view=CALL_READY" className={buttonClass('primary')}>
              Call-ready leads
            </Link>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Call ready" value={callReady} tone="hot" />
        <Stat label="Active queues" value={active.length} />
        <Stat label="Calls started (7d)" value={metrics.attempted} />
        <Stat label="Dispositioned" value={metrics.dispositioned} />
        <Stat label="Booked" value={metrics.booked} tone="positive" />
        <Stat label="Callbacks" value={metrics.callback} tone="warning" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div>
          <SectionTitle>New queue</SectionTitle>
          <Card>
            <QueueForm
              industries={industries}
              cities={cities}
              callReady={callReady}
              canWrite={ctx.role !== 'VIEWER'}
            />
          </Card>

          <Card className="mt-4">
            <SectionTitle>Last 7 days</SectionTitle>
            <div className="space-y-3">
              <Meter
                label="Marked as reaching someone"
                value={metrics.booked + metrics.callback + metrics.notInterested + metrics.qualified}
                max={Math.max(metrics.dispositioned, 1)}
                tone="accent"
                caption={`of ${metrics.dispositioned} dispositioned`}
              />
              <Meter
                label="Booked"
                value={metrics.booked}
                max={Math.max(metrics.attempted, 1)}
                tone="positive"
                caption={`of ${metrics.attempted} started`}
              />
            </div>
            <p className="mt-3 text-xs text-ink-500">
              {provider.reportsConnection
                ? 'Your call provider reports connection, so these are measured.'
                : `Calls are handed to the device with a tel: link, so the app knows a call was started and nothing more. Contact rate above is what operators marked, not a measured connect rate.`}
            </p>
          </Card>
        </div>

        <div>
          <SectionTitle>Queues</SectionTitle>
          {queues.length === 0 ? (
            <EmptyState
              title="No call queues yet"
              description={
                callReady > 0
                  ? `${callReady} leads are call-ready. Build a queue from the form on the left.`
                  : 'No leads are call-ready yet. Run a lead search, let it enrich, then come back.'
              }
              action={
                callReady === 0 ? (
                  <Link href="/lead-generation" className={buttonClass('primary')}>
                    Generate leads
                  </Link>
                ) : null
              }
            />
          ) : (
            <QueueList
              queues={queues.map((q) => ({
                id: q.queue.id,
                name: q.queue.name,
                description: q.queue.description,
                status: q.queue.status,
                total: q.queue.totalCount,
                completed: q.queue.completedCount,
                skipped: q.queue.skippedCount,
                remaining: q.remaining,
                createdAt: q.queue.createdAt,
              }))}
              canWrite={ctx.role !== 'VIEWER'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
