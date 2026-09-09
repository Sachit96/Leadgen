import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { listCallQueues } from '@/lib/services/call-queue';
import { callMetrics, dueCallbacks } from '@/lib/services/calls';
import { startOfDayUtc } from '@/lib/core/time';
import { getCallProvider, telUri } from '@/lib/providers/call';
import { Badge, Card, EmptyState, PageHeader, SectionTitle, Stat } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { CallLink } from '@/components/call-link';

export const dynamic = 'force-dynamic';

export default async function CallsTodayPage() {
  const ctx = await requireCtx('prospect:read');
  const since = startOfDayUtc();
  const provider = getCallProvider();

  const [metrics, callbacks, queues] = await Promise.all([
    callMetrics(ctx, since),
    dueCallbacks(ctx),
    listCallQueues(ctx),
  ]);

  const active = queues.filter((q) => q.queue.status === 'ACTIVE' && q.remaining > 0);
  const remaining = active.reduce((total, q) => total + q.remaining, 0);

  return (
    <div className="p-6">
      <PageHeader
        title="Today"
        subtitle="What is owed today, and what is left to dial."
        actions={
          <Link href="/calls" className={buttonClass('secondary')}>
            All queues
          </Link>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Calls started" value={metrics.attempted} />
        <Stat label="Outcomes marked" value={metrics.dispositioned} />
        <Stat label="Booked" value={metrics.booked} tone="positive" />
        <Stat label="Callbacks due" value={callbacks.length} tone={callbacks.length > 0 ? 'warning' : 'neutral'} />
        <Stat label="Left in queues" value={remaining} tone="hot" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <SectionTitle>Callbacks due</SectionTitle>
          {callbacks.length === 0 ? (
            <EmptyState title="Nothing owed" description="No callbacks are due right now." />
          ) : (
            <div className="space-y-2">
              {callbacks.map((callback) => (
                <Card key={callback.contactId}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/prospects/${callback.contactId}`}
                        className="truncate text-sm font-medium text-ink-100 hover:text-accent-400"
                      >
                        {callback.companyName ??
                          [callback.firstName, callback.lastName].filter(Boolean).join(' ') ??
                          callback.phone}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {callback.dueAt ? new Date(callback.dueAt).toLocaleString('en-CA') : 'no time set'}
                        {callback.city ? ` · ${callback.city}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {callback.score !== null ? <Badge>score {callback.score}</Badge> : null}
                      <CallLink
                        contactId={callback.contactId}
                        phone={callback.phone}
                        dialUri={telUri(callback.phone)}
                        disabled={ctx.role === 'VIEWER'}
                      />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionTitle>Queues with work left</SectionTitle>
          {active.length === 0 ? (
            <EmptyState
              title="No active queue has anything left"
              description="Build a queue, or top up an existing one with newly call-ready leads."
              action={
                <Link href="/calls" className={buttonClass('primary')}>
                  Go to queues
                </Link>
              }
            />
          ) : (
            <div className="space-y-2">
              {active.map((q) => (
                <Card key={q.queue.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-100">{q.queue.name}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {q.remaining} of {q.queue.totalCount} left
                      </p>
                    </div>
                    <Link href={`/calls/${q.queue.id}`} className={buttonClass('primary', 'sm')}>
                      Start calling
                    </Link>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="mt-6 text-xs text-ink-600">
        {provider.reportsConnection
          ? 'Your call provider reports call progress, so connect data here is measured.'
          : 'Calls are placed by your phone through a tel: link. The app records that a call was started and whatever outcome you mark — it never observes whether the call connected.'}
      </p>
    </div>
  );
}
