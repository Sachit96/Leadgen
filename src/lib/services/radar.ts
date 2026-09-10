import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts, conversations, leadSignals, messages } from '@/lib/db/schema';
import { funnelMetrics, leadFunnel, resolveRange, type DateRange } from './analytics';
import { leadViewCounts } from './leads';
import { listMessages } from './messages';
import type { Ctx } from '@/lib/auth/context';

/**
 * The control room's ten stages.
 *
 * Every number here is a count of rows the system actually wrote. A stage that
 * has not run yet reads zero, which is the point: the display is an instrument,
 * and an instrument that invents a reading is worse than no instrument.
 *
 * `detail` is the second line under the value — a rate, a ratio, or the reason
 * the number is what it is.
 *
 * `flow` is a conversion rate, and it is only shown where one stage is genuinely
 * a subset of another. That is not always the previous card: research runs on
 * leads whose website never loaded, so crawled → researched is not a funnel step
 * and reporting it as one produced a "119.4% converted", which is nonsense on a
 * screen whose whole job is to be trusted at a glance. Each stage therefore
 * names its own denominator, and a rate over an empty denominator is null —
 * unknown — rather than zero.
 */
export type RadarStage = {
  key: string;
  group: string;
  label: string;
  value: number;
  /** Rendered as-is; already formatted for money and rates. */
  display: string;
  detail: string;
  /** A conversion rate, or null when its denominator is empty. */
  flow: number | null;
  /** What `flow` is a percentage of. Shown, so the rate is never ambiguous. */
  flowOf: string | null;
  icon: RadarIcon;
};

export type RadarIcon =
  | 'radar'
  | 'layers'
  | 'brain'
  | 'clipboard'
  | 'message'
  | 'sparkles'
  | 'calendar'
  | 'kanban'
  | 'banknote'
  | 'chart';

export type RadarThread = {
  companyName: string | null;
  city: string | null;
  state: string;
  intent: string | null;
  turns: Array<{ id: string; direction: 'OUTBOUND' | 'INBOUND'; author: string; body: string; at: string }>;
};

export type RadarSnapshot = {
  range: DateRange;
  stages: RadarStage[];
  groups: string[];
  thread: RadarThread | null;
  headline: {
    discovered: number;
    revenueCents: number;
    conversion: number;
    signals: number;
  };
};

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function money(cents: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export async function radarSnapshot(ctx: Ctx, preset = '30d'): Promise<RadarSnapshot> {
  const range = resolveRange(preset);
  const db = getDb();

  const [leads, funnel, views, signalRows, threadRow] = await Promise.all([
    leadFunnel(ctx, range),
    funnelMetrics(ctx, range),
    leadViewCounts(ctx),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadSignals)
      .where(and(eq(leadSignals.organizationId, ctx.organizationId), eq(leadSignals.detected, true))),
    // The most recently active conversation, for the live SMS panel.
    db
      .select({
        id: conversations.id,
        state: conversations.state,
        intent: conversations.intent,
        companyName: companies.name,
        city: companies.city,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .where(
        and(
          eq(conversations.organizationId, ctx.organizationId),
          sql`exists (select 1 from ${messages} m where m.conversation_id = ${conversations.id})`,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  ]);

  const detectedSignals = signalRows[0]?.count ?? 0;
  const approved = views.APPROVED ?? 0;

  const stages: RadarStage[] = [
    {
      key: 'lead_generation',
      group: 'Acquisition',
      label: 'Lead Generation',
      value: leads.discovered,
      display: leads.discovered.toLocaleString(),
      detail:
        leads.searches > 0
          ? `${leads.searches} ${leads.searches === 1 ? 'run' : 'runs'} · ${leads.duplicates} duplicates removed`
          : 'no searches in this range',
      flow: null,
      flowOf: null,
      icon: 'radar',
    },
    {
      key: 'enrichment',
      group: 'Acquisition',
      label: 'Enrichment',
      value: leads.crawled,
      display: leads.crawled.toLocaleString(),
      detail:
        leads.promoted > 0
          ? `${leads.promoted} promoted to the CRM · ${leads.crawlFailed} sites would not load`
          : 'nothing promoted yet',
      // Of the leads in the CRM, how many had a site we could read.
      flow: rate(leads.crawled, leads.promoted),
      flowOf: 'of leads in the CRM',
      icon: 'layers',
    },
    {
      key: 'intelligence',
      group: 'Assessment',
      label: 'Intelligence',
      value: leads.researched,
      display: leads.researched.toLocaleString(),
      // Research also runs on leads with no reachable site, working from the
      // discovery data alone — so it is measured against everything promoted.
      detail: `${detectedSignals.toLocaleString()} signals detected with evidence`,
      flow: rate(leads.researched, leads.promoted),
      flowOf: 'of leads in the CRM',
      icon: 'brain',
    },
    {
      key: 'review',
      group: 'Assessment',
      label: 'Review',
      value: approved,
      display: approved.toLocaleString(),
      detail: `${(views.REVIEW ?? 0).toLocaleString()} awaiting a human · ${(views.REJECTED ?? 0).toLocaleString()} rejected`,
      flow: rate(approved, leads.scored),
      flowOf: 'of leads scored',
      icon: 'clipboard',
    },
    {
      key: 'sms',
      group: 'Outreach',
      label: 'SMS',
      value: funnel.sent,
      display: funnel.sent.toLocaleString(),
      detail: `${funnel.deliveryRate}% delivered · ${funnel.prospectsContacted} prospects reached`,
      flow: rate(funnel.prospectsContacted, approved),
      flowOf: 'of approved leads',
      icon: 'message',
    },
    {
      key: 'qualification',
      group: 'Outreach',
      label: 'AI Qualification',
      value: funnel.qualified,
      display: funnel.qualified.toLocaleString(),
      detail: `${funnel.replies} replies · ${funnel.positiveReplies} positive`,
      flow: rate(funnel.qualified, funnel.replies),
      flowOf: 'of replies',
      icon: 'sparkles',
    },
    {
      key: 'appointment',
      group: 'Conversion',
      label: 'Appointment',
      value: funnel.appointments,
      display: funnel.appointments.toLocaleString(),
      detail:
        funnel.appointments > 0
          ? `${funnel.showRate}% showed up`
          : 'none booked in this range',
      flow: rate(funnel.appointments, funnel.qualified),
      flowOf: 'of qualified',
      icon: 'calendar',
    },
    {
      key: 'pipeline',
      group: 'Conversion',
      label: 'Pipeline',
      value: funnel.opportunities,
      display: funnel.opportunities.toLocaleString(),
      detail: `${funnel.won} won · ${funnel.closeRate}% close rate`,
      flow: rate(funnel.opportunities, funnel.appointments),
      flowOf: 'of appointments',
      icon: 'kanban',
    },
    {
      key: 'revenue',
      group: 'Results',
      label: 'Revenue',
      value: funnel.revenueCents,
      display: money(funnel.revenueCents),
      detail:
        funnel.recurringRevenueCents > 0
          ? `${money(funnel.recurringRevenueCents)} of it recurring`
          : 'no recurring revenue booked',
      flow: rate(funnel.won, funnel.opportunities),
      flowOf: 'of opportunities won',
      icon: 'banknote',
    },
    {
      key: 'analytics',
      group: 'Results',
      label: 'Analytics',
      value: funnel.revenuePer100Prospects,
      display: money(funnel.revenuePer100Prospects),
      detail: 'revenue per 100 prospects contacted',
      flow: null,
      flowOf: null,
      icon: 'chart',
    },
  ];

  let thread: RadarThread | null = null;
  const conversation = threadRow[0];
  if (conversation) {
    const rows = await listMessages(ctx, conversation.id, 8);
    thread = {
      companyName: conversation.companyName,
      city: conversation.city,
      state: conversation.state,
      intent: conversation.intent,
      turns: rows.slice(-6).map((message) => ({
        id: message.id,
        direction: message.direction,
        author: message.author,
        body: message.body,
        at: message.createdAt.toISOString(),
      })),
    };
  }

  return {
    range,
    stages,
    groups: [...new Set(stages.map((stage) => stage.group))],
    thread,
    headline: {
      discovered: leads.discovered,
      revenueCents: funnel.revenueCents,
      // End to end: of everyone contacted, how many became revenue.
      conversion: rate(funnel.won, funnel.prospectsContacted) ?? 0,
      signals: detectedSignals,
    },
  };
}
