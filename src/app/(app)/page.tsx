import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { formatRelative } from '@/lib/core/time';
import { formatPhone } from '@/lib/core/phone';
import { campaignPerformance, funnelMetrics, resolveRange } from '@/lib/services/analytics';
import { listInbox } from '@/lib/services/conversations';
import { listAppointments } from '@/lib/services/appointments';
import { listOpenTasks } from '@/lib/services/tasks';
import { formatMoney, getOrgConfig } from '@/lib/services/settings';
import { queueStats } from '@/lib/services/queue';
import { callMetrics, dueCallbacks } from '@/lib/services/calls';
import { listCallQueues } from '@/lib/services/call-queue';
import { leadViewCounts } from '@/lib/services/leads';
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
  Stat,
  Meter,
} from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { ConversationStateBadge, TemperatureBadge } from '@/components/ui/status';
import { TaskRow } from './task-row';

export const dynamic = 'force-dynamic';

/**
 * Today — the daily command center.
 *
 * Ordered by what needs a person: conversations waiting on a human first, then
 * today's calls, then the work queue. Numbers are all computed from real rows.
 */
export default async function TodayPage() {
  const ctx = await requireCtx();
  const now = new Date();
  const range = resolveRange('today');
  const thirty = resolveRange('30d');

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const [
    today,
    month,
    needsHuman,
    hot,
    appointments,
    tasks,
    campaigns,
    queue,
    config,
    callsToday,
    callbacks,
    callQueues,
    leadCounts,
  ] = await Promise.all([
    funnelMetrics(ctx, range),
    funnelMetrics(ctx, thirty),
    listInbox(ctx, { filter: 'needs_human', limit: 6 }),
    listInbox(ctx, { filter: 'hot', limit: 6 }),
    listAppointments(ctx, { from: new Date(), to: endOfDay, limit: 10 }),
    listOpenTasks(ctx, { dueBefore: endOfDay, limit: 8 }),
    campaignPerformance(ctx, thirty),
    queueStats(ctx),
    getOrgConfig(ctx),
    callMetrics(ctx, range.from),
    dueCallbacks(ctx),
    listCallQueues(ctx),
    leadViewCounts(ctx),
  ]);

  const activeCampaigns = campaigns.filter((c) => c.status === 'ACTIVE');
  const leftToCall = callQueues
    .filter((q) => q.queue.status === 'ACTIVE')
    .reduce((total, q) => total + q.remaining, 0);

  return (
    <div className="p-6">
      <PageHeader
        title="Today"
        subtitle={new Date().toLocaleDateString('en-CA', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
        actions={
          <>
            <Link href="/inbox?filter=needs_human" className={buttonClass('secondary')}>
              Review handoffs
            </Link>
            <Link href="/prospects" className={buttonClass('primary')}>
              Work prospects
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Contacted today" value={today.prospectsContacted} />
        <Stat label="Messages sent" value={today.sent} sublabel={`${today.deliveryRate}% delivered`} />
        <Stat
          label="Replies"
          value={today.replies}
          sublabel={`${today.replyRate}% reply rate`}
          tone={today.replies > 0 ? 'positive' : 'neutral'}
        />
        <Stat
          label="Need a human"
          value={needsHuman.total}
          tone={needsHuman.total > 0 ? 'warning' : 'neutral'}
          href="/inbox?filter=needs_human"
        />
        <Stat
          label="Appointments today"
          value={appointments.length}
          tone={appointments.length > 0 ? 'hot' : 'neutral'}
          href="/calendar"
        />
        <Stat
          label="Revenue (30d)"
          value={formatMoney(month.revenueCents, config.offer.currency)}
          tone={month.revenueCents > 0 ? 'positive' : 'neutral'}
          href="/analytics"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Left to call"
          value={leftToCall}
          tone={leftToCall > 0 ? 'hot' : 'neutral'}
          sublabel="across active queues"
          href="/calls/today"
        />
        <Stat
          label="Callbacks due"
          value={callbacks.length}
          tone={callbacks.length > 0 ? 'warning' : 'neutral'}
          href="/calls/today"
        />
        <Stat
          label="Calls started today"
          value={callsToday.attempted}
          sublabel={`${callsToday.dispositioned} marked`}
          href="/calls"
        />
        <Stat
          label="Booked on calls today"
          value={callsToday.booked}
          tone={callsToday.booked > 0 ? 'positive' : 'neutral'}
          href="/calls"
        />
        <Stat
          label="Call-ready leads"
          value={leadCounts.CALL_READY ?? 0}
          sublabel={`${leadCounts.REVIEW ?? 0} awaiting review`}
          href="/lead-generation/leads?view=CALL_READY"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section>
            <SectionTitle
              action={
                <Link href="/inbox?filter=needs_human" className="text-xs text-accent-400 hover:underline">
                  Open inbox
                </Link>
              }
            >
              Waiting on a human
            </SectionTitle>
            {needsHuman.rows.length === 0 ? (
              <EmptyState
                title="Nothing needs you right now"
                description="The AI hands a conversation over whenever it hits pricing, contracts, a request for a person, or its own uncertainty."
              />
            ) : (
              <div className="space-y-2">
                {needsHuman.rows.map((row) => (
                  <Link
                    key={row.id}
                    href={`/inbox/${row.id}`}
                    className="block rounded-lg border border-warning-500/30 bg-ink-850 p-3 transition-colors hover:border-warning-500/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-100">
                          {row.companyName ?? formatPhone(row.phone)}
                          {row.firstName ? (
                            <span className="ml-1.5 font-normal text-ink-400">{row.firstName}</span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-ink-400">{row.lastMessageBody}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <TemperatureBadge temperature={row.leadTemperature} />
                        <span className="text-[11px] text-ink-500">
                          {formatRelative(row.lastMessageAt)}
                        </span>
                      </div>
                    </div>
                    {row.handoffReason ? (
                      <p className="mt-2 text-xs text-warning-400">↑ {row.handoffReason}</p>
                    ) : null}
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionTitle
              action={
                <Link href="/inbox?filter=hot" className="text-xs text-accent-400 hover:underline">
                  See all
                </Link>
              }
            >
              Hot conversations
            </SectionTitle>
            {hot.rows.length === 0 ? (
              <EmptyState
                title="No hot conversations yet"
                description="A conversation turns hot when the prospect shows real buying intent."
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {hot.rows.map((row) => (
                  <Link
                    key={row.id}
                    href={`/inbox/${row.id}`}
                    className="rounded-lg border border-ink-700 bg-ink-850 p-3 transition-colors hover:border-ink-600"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-ink-100">
                        {row.companyName ?? formatPhone(row.phone)}
                      </p>
                      <ConversationStateBadge state={row.state} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-ink-400">{row.lastMessageBody}</p>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionTitle
              action={
                <Link href="/analytics" className="text-xs text-accent-400 hover:underline">
                  Full analytics
                </Link>
              }
            >
              Campaign performance · 30 days
            </SectionTitle>
            {activeCampaigns.length === 0 ? (
              <EmptyState
                title="No active campaigns"
                description="Create a campaign, add prospects, and activate it to start conversations."
                action={
                  <Link href="/campaigns" className={buttonClass('primary')}>
                    Go to campaigns
                  </Link>
                }
              />
            ) : (
              <Card className="space-y-4">
                {activeCampaigns.slice(0, 4).map((campaign) => (
                  <div key={campaign.campaignId}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <Link
                        href={`/campaigns/${campaign.campaignId}`}
                        className="truncate text-sm font-medium text-ink-100 hover:text-accent-400"
                      >
                        {campaign.campaignName}
                      </Link>
                      <span className="shrink-0 text-xs tabular-nums text-ink-400">
                        {campaign.replyRate}% reply · {campaign.appointments} booked
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Meter label="Sent" value={campaign.sent} max={Math.max(campaign.prospects, 1)} />
                      <Meter
                        label="Replies"
                        value={campaign.replies}
                        max={Math.max(campaign.sent, 1)}
                        tone="positive"
                      />
                      <Meter
                        label="Appointments"
                        value={campaign.appointments}
                        max={Math.max(campaign.replies, 1)}
                        tone="hot"
                      />
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <SectionTitle
              action={
                <Link href="/calendar" className="text-xs text-accent-400 hover:underline">
                  Calendar
                </Link>
              }
            >
              Today&apos;s calls
            </SectionTitle>
            {appointments.length === 0 ? (
              <EmptyState title="No calls booked today" />
            ) : (
              <Card padded={false}>
                <ul className="divide-y divide-ink-800">
                  {appointments.map(({ appointment, contact }) => (
                    <li key={appointment.id} className="flex items-center gap-3 p-3">
                      <div className="w-14 shrink-0 text-xs font-medium tabular-nums text-accent-400">
                        {new Intl.DateTimeFormat('en-CA', {
                          timeZone: appointment.timezone,
                          hour: 'numeric',
                          minute: '2-digit',
                        }).format(appointment.startsAt)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink-100">{appointment.title}</p>
                        <p className="truncate text-xs text-ink-500">{formatPhone(contact.phone)}</p>
                      </div>
                      <Badge tone={appointment.status === 'SCHEDULED' ? 'accent' : 'neutral'}>
                        {appointment.status.toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>

          <section>
            <SectionTitle>Tasks due</SectionTitle>
            {tasks.length === 0 ? (
              <EmptyState title="No open tasks" description="Tasks you create from a conversation or prospect show up here." />
            ) : (
              <Card padded={false}>
                <ul className="divide-y divide-ink-800">
                  {tasks.map((row) => (
                    <TaskRow
                      key={row.task.id}
                      row={row}
                      overdue={row.task.dueAt ? row.task.dueAt < now : false}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </section>

          <section>
            <SectionTitle>Sending queue</SectionTitle>
            <Card className="space-y-1">
              <QueueLine label="Pending" value={queue.pending} />
              <QueueLine label="Processing" value={queue.processing} />
              <QueueLine label="Sent" value={queue.succeeded} />
              <QueueLine label="Dead-lettered" value={queue.dead} tone={queue.dead > 0 ? 'danger' : 'neutral'} />
              {queue.dead > 0 ? (
                <Link href="/settings#queue" className="mt-2 block text-xs text-accent-400 hover:underline">
                  Review failed messages
                </Link>
              ) : null}
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}

function QueueLine({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-ink-400">{label}</span>
      <span
        className={`tabular-nums ${tone === 'danger' ? 'font-medium text-danger-400' : 'text-ink-200'}`}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}
