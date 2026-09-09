import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { outer } from '@/lib/db/sql';
import { getDb } from '@/lib/db';
import {
  appointments,
  callAttempts,
  campaignMemberships,
  campaignVariants,
  campaigns,
  companies,
  contacts,
  conversations,
  leadDiscoveryRecords,
  leadEnrichment,
  leadPersonalization,
  leadSearchJobs,
  messages,
  pipelineDeals,
} from '@/lib/db/schema';
import { daysAgo } from '@/lib/core/time';
import type { Ctx } from '@/lib/auth/context';

export type DateRange = { from: Date; to: Date; label: string };

export const RANGE_PRESETS = ['today', '7d', '30d', '90d', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function resolveRange(preset: string | undefined, custom?: { from?: string; to?: string }): DateRange {
  if (custom?.from) {
    const from = new Date(custom.from);
    const to = custom.to ? new Date(custom.to) : new Date();
    if (!Number.isNaN(from.getTime())) {
      return { from, to, label: 'Custom' };
    }
  }

  switch (preset) {
    case 'today': {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      return { from, to: new Date(), label: 'Today' };
    }
    case '7d':
      return { from: daysAgo(7), to: new Date(), label: 'Last 7 days' };
    case '90d':
      return { from: daysAgo(90), to: new Date(), label: 'Last 90 days' };
    case 'all':
      return { from: new Date(0), to: new Date(), label: 'All time' };
    default:
      return { from: daysAgo(30), to: new Date(), label: 'Last 30 days' };
  }
}

/**
 * The funnel, computed in SQL in one pass per entity.
 *
 * Rates are derived here rather than in the UI so every screen reports the same
 * number, and denominators are explicit: reply rate is over *delivered*, not
 * over queued, because a message that never arrived cannot earn a reply.
 */
export type FunnelMetrics = {
  prospectsContacted: number;
  sent: number;
  delivered: number;
  failed: number;
  replies: number;
  positiveReplies: number;
  qualified: number;
  appointments: number;
  appointmentsShowed: number;
  opportunities: number;
  won: number;
  revenueCents: number;
  recurringRevenueCents: number;

  deliveryRate: number;
  replyRate: number;
  positiveReplyRate: number;
  qualificationRate: number;
  bookingRate: number;
  showRate: number;
  closeRate: number;
  revenuePer100Prospects: number;
};

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export async function funnelMetrics(
  ctx: Ctx,
  range: DateRange,
  options: { campaignId?: string } = {},
): Promise<FunnelMetrics> {
  const db = getDb();

  const messageClauses: SQL[] = [
    eq(messages.organizationId, ctx.organizationId),
    gte(messages.createdAt, range.from),
    lte(messages.createdAt, range.to),
  ];
  if (options.campaignId) messageClauses.push(eq(messages.campaignId, options.campaignId));

  const messageRows = await db
    .select({
      sent: sql<number>`count(*) filter (where ${messages.direction} = 'OUTBOUND' and ${messages.status} in ('SENT','DELIVERED'))::int`,
      delivered: sql<number>`count(*) filter (where ${messages.direction} = 'OUTBOUND' and ${messages.status} = 'DELIVERED')::int`,
      failed: sql<number>`count(*) filter (where ${messages.direction} = 'OUTBOUND' and ${messages.status} in ('FAILED','UNDELIVERED'))::int`,
      inbound: sql<number>`count(*) filter (where ${messages.direction} = 'INBOUND')::int`,
      contacted: sql<number>`count(distinct ${messages.contactId}) filter (where ${messages.direction} = 'OUTBOUND')::int`,
      replied: sql<number>`count(distinct ${messages.contactId}) filter (where ${messages.direction} = 'INBOUND')::int`,
    })
    .from(messages)
    .where(and(...messageClauses));

  const m = messageRows[0] ?? {
    sent: 0,
    delivered: 0,
    failed: 0,
    inbound: 0,
    contacted: 0,
    replied: 0,
  };

  const conversationClauses: SQL[] = [
    eq(conversations.organizationId, ctx.organizationId),
    gte(conversations.createdAt, range.from),
    lte(conversations.createdAt, range.to),
  ];
  if (options.campaignId) conversationClauses.push(eq(conversations.campaignId, options.campaignId));

  const conversationRows = await db
    .select({
      positive: sql<number>`count(*) filter (where ${conversations.intent} = 'positive')::int`,
      qualified: sql<number>`count(*) filter (where ${conversations.state} in ('QUALIFICATION','VALUE','OBJECTION','APPOINTMENT','BOOKED'))::int`,
    })
    .from(conversations)
    .where(and(...conversationClauses));

  const c = conversationRows[0] ?? { positive: 0, qualified: 0 };

  const appointmentClauses: SQL[] = [
    eq(appointments.organizationId, ctx.organizationId),
    gte(appointments.createdAt, range.from),
    lte(appointments.createdAt, range.to),
  ];
  if (options.campaignId) appointmentClauses.push(eq(appointments.campaignId, options.campaignId));

  const appointmentRows = await db
    .select({
      booked: sql<number>`count(*)::int`,
      showed: sql<number>`count(*) filter (where ${appointments.status} = 'COMPLETED')::int`,
    })
    .from(appointments)
    .where(and(...appointmentClauses));

  const a = appointmentRows[0] ?? { booked: 0, showed: 0 };

  const dealClauses: SQL[] = [
    eq(pipelineDeals.organizationId, ctx.organizationId),
    gte(pipelineDeals.createdAt, range.from),
    lte(pipelineDeals.createdAt, range.to),
  ];
  if (options.campaignId) dealClauses.push(eq(pipelineDeals.campaignId, options.campaignId));

  const dealRows = await db
    .select({
      opportunities: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${pipelineDeals.stage} = 'WON')::int`,
      revenue: sql<number>`coalesce(sum(${pipelineDeals.valueCents}) filter (where ${pipelineDeals.stage} = 'WON'), 0)::int`,
      recurring: sql<number>`coalesce(sum(${pipelineDeals.recurringValueCents}) filter (where ${pipelineDeals.stage} = 'WON'), 0)::int`,
    })
    .from(pipelineDeals)
    .where(and(...dealClauses));

  const d = dealRows[0] ?? { opportunities: 0, won: 0, revenue: 0, recurring: 0 };

  return {
    prospectsContacted: m.contacted,
    sent: m.sent,
    delivered: m.delivered,
    failed: m.failed,
    replies: m.replied,
    positiveReplies: c.positive,
    qualified: c.qualified,
    appointments: a.booked,
    appointmentsShowed: a.showed,
    opportunities: d.opportunities,
    won: d.won,
    revenueCents: d.revenue,
    recurringRevenueCents: d.recurring,

    deliveryRate: rate(m.delivered, m.sent),
    replyRate: rate(m.replied, m.contacted),
    positiveReplyRate: rate(c.positive, m.replied),
    qualificationRate: rate(c.qualified, m.replied),
    bookingRate: rate(a.booked, c.qualified),
    showRate: rate(a.showed, a.booked),
    closeRate: rate(d.won, d.opportunities),
    revenuePer100Prospects:
      m.contacted > 0 ? Math.round((d.revenue / m.contacted) * 100) : 0,
  };
}

export type CampaignPerformance = {
  campaignId: string;
  campaignName: string;
  status: string;
  prospects: number;
  sent: number;
  delivered: number;
  replies: number;
  positiveReplies: number;
  appointments: number;
  won: number;
  revenueCents: number;
  replyRate: number;
  bookingRate: number;
  revenuePer100Prospects: number;
};

export async function campaignPerformance(
  ctx: Ctx,
  range: DateRange,
): Promise<CampaignPerformance[]> {
  const rows = await getDb()
    .select({
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      status: campaigns.status,
      prospects: sql<number>`(
        select count(*)::int from ${campaignMemberships} cm where cm.campaign_id = ${outer(campaigns.id)}
      )`,
      sent: sql<number>`(
        select count(*)::int from ${messages} m
        where m.campaign_id = ${outer(campaigns.id)} and m.direction = 'OUTBOUND'
          and m.status in ('SENT','DELIVERED')
          and m.created_at between ${range.from} and ${range.to}
      )`,
      delivered: sql<number>`(
        select count(*)::int from ${messages} m
        where m.campaign_id = ${outer(campaigns.id)} and m.status = 'DELIVERED'
          and m.created_at between ${range.from} and ${range.to}
      )`,
      contacted: sql<number>`(
        select count(distinct m.contact_id)::int from ${messages} m
        where m.campaign_id = ${outer(campaigns.id)} and m.direction = 'OUTBOUND'
          and m.created_at between ${range.from} and ${range.to}
      )`,
      replies: sql<number>`(
        select count(distinct m.contact_id)::int from ${messages} m
        where m.campaign_id = ${outer(campaigns.id)} and m.direction = 'INBOUND'
          and m.created_at between ${range.from} and ${range.to}
      )`,
      positiveReplies: sql<number>`(
        select count(*)::int from ${conversations} cv
        where cv.campaign_id = ${outer(campaigns.id)} and cv.intent = 'positive'
      )`,
      appointments: sql<number>`(
        select count(*)::int from ${appointments} ap
        where ap.campaign_id = ${outer(campaigns.id)}
          and ap.created_at between ${range.from} and ${range.to}
      )`,
      won: sql<number>`(
        select count(*)::int from ${pipelineDeals} pd
        where pd.campaign_id = ${outer(campaigns.id)} and pd.stage = 'WON'
      )`,
      revenueCents: sql<number>`(
        select coalesce(sum(pd.value_cents), 0)::int from ${pipelineDeals} pd
        where pd.campaign_id = ${outer(campaigns.id)} and pd.stage = 'WON'
      )`,
    })
    .from(campaigns)
    .where(eq(campaigns.organizationId, ctx.organizationId))
    .orderBy(sql`4 desc`);

  return rows.map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    status: r.status,
    prospects: r.prospects,
    sent: r.sent,
    delivered: r.delivered,
    replies: r.replies,
    positiveReplies: r.positiveReplies,
    appointments: r.appointments,
    won: r.won,
    revenueCents: r.revenueCents,
    replyRate: rate(r.replies, r.contacted),
    bookingRate: rate(r.appointments, r.replies),
    revenuePer100Prospects: r.contacted > 0 ? Math.round((r.revenueCents / r.contacted) * 100) : 0,
  }));
}

export type VariantPerformance = {
  variantId: string;
  variantName: string;
  angle: string;
  campaignName: string;
  stepId: string;
  messages: number;
  replies: number;
  positiveReplies: number;
  qualified: number;
  appointments: number;
  revenueCents: number;
  replyRate: number;
  positiveRate: number;
  /** False until the arm has enough sends to mean anything. */
  significant: boolean;
};

const MIN_SAMPLE_FOR_SIGNIFICANCE = 30;

/**
 * Per-variant results.
 *
 * A variant is only marked `significant` once it has cleared a minimum sample,
 * so nobody scales a "60% reply rate" that came from five messages.
 */
export async function variantPerformance(ctx: Ctx, campaignId?: string): Promise<VariantPerformance[]> {
  const clauses: SQL[] = [eq(campaignVariants.organizationId, ctx.organizationId)];
  if (campaignId) clauses.push(eq(campaignVariants.campaignId, campaignId));

  const rows = await getDb()
    .select({
      variantId: campaignVariants.id,
      variantName: campaignVariants.name,
      angle: campaignVariants.angle,
      stepId: campaignVariants.stepId,
      campaignName: campaigns.name,
      messages: sql<number>`(
        select count(*)::int from ${messages} m where m.variant_id = ${outer(campaignVariants.id)}
      )`,
      replies: sql<number>`(
        select count(distinct inb.contact_id)::int
        from ${messages} inb
        where inb.direction = 'INBOUND'
          and inb.contact_id in (
            select m.contact_id from ${messages} m where m.variant_id = ${outer(campaignVariants.id)}
          )
      )`,
      positiveReplies: sql<number>`(
        select count(*)::int from ${conversations} cv
        where cv.intent = 'positive' and cv.contact_id in (
          select m.contact_id from ${messages} m where m.variant_id = ${outer(campaignVariants.id)}
        )
      )`,
      qualified: sql<number>`(
        select count(*)::int from ${conversations} cv
        where cv.state in ('QUALIFICATION','VALUE','APPOINTMENT','BOOKED')
          and cv.contact_id in (
            select m.contact_id from ${messages} m where m.variant_id = ${outer(campaignVariants.id)}
          )
      )`,
      appointments: sql<number>`(
        select count(*)::int from ${appointments} ap
        where ap.contact_id in (
          select m.contact_id from ${messages} m where m.variant_id = ${outer(campaignVariants.id)}
        )
      )`,
      revenueCents: sql<number>`(
        select coalesce(sum(pd.value_cents), 0)::int from ${pipelineDeals} pd
        where pd.stage = 'WON' and pd.variant_id = ${outer(campaignVariants.id)}
      )`,
    })
    .from(campaignVariants)
    .innerJoin(campaigns, eq(campaigns.id, campaignVariants.campaignId))
    .where(and(...clauses));

  return rows
    .map((r) => ({
      ...r,
      replyRate: rate(r.replies, r.messages),
      positiveRate: rate(r.positiveReplies, r.messages),
      significant: r.messages >= MIN_SAMPLE_FOR_SIGNIFICANCE,
    }))
    .sort((a, b) => b.replyRate - a.replyRate);
}

/** Daily series for the dashboard charts. */
export type DailyPoint = {
  day: string;
  sent: number;
  delivered: number;
  replies: number;
  appointments: number;
};

export async function dailySeries(ctx: Ctx, range: DateRange): Promise<DailyPoint[]> {
  const rows = await getDb().execute(sql`
    with days as (
      select generate_series(
        date_trunc('day', ${range.from}::timestamptz),
        date_trunc('day', ${range.to}::timestamptz),
        interval '1 day'
      ) as day
    )
    select
      to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(*) from messages m
        where m.organization_id = ${ctx.organizationId}
          and m.direction = 'OUTBOUND' and m.status in ('SENT','DELIVERED')
          and date_trunc('day', m.created_at) = d.day)::int as sent,
      (select count(*) from messages m
        where m.organization_id = ${ctx.organizationId}
          and m.status = 'DELIVERED'
          and date_trunc('day', m.created_at) = d.day)::int as delivered,
      (select count(*) from messages m
        where m.organization_id = ${ctx.organizationId}
          and m.direction = 'INBOUND'
          and date_trunc('day', m.created_at) = d.day)::int as replies,
      (select count(*) from appointments ap
        where ap.organization_id = ${ctx.organizationId}
          and date_trunc('day', ap.created_at) = d.day)::int as appointments
    from days d
    order by d.day
  `);

  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  return list.map((r) => ({
    day: String(r.day),
    sent: Number(r.sent ?? 0),
    delivered: Number(r.delivered ?? 0),
    replies: Number(r.replies ?? 0),
    appointments: Number(r.appointments ?? 0),
  }));
}

/** Revenue grouped by the prospect's original source. */
export async function revenueBySource(ctx: Ctx) {
  const rows = await getDb()
    .select({
      source: sql<string>`coalesce(${contacts.source}, 'unknown')`,
      prospects: sql<number>`count(distinct ${contacts.id})::int`,
      revenueCents: sql<number>`coalesce(sum(${pipelineDeals.valueCents}) filter (where ${pipelineDeals.stage} = 'WON'), 0)::int`,
    })
    .from(contacts)
    .leftJoin(pipelineDeals, eq(pipelineDeals.contactId, contacts.id))
    .where(eq(contacts.organizationId, ctx.organizationId))
    .groupBy(sql`coalesce(${contacts.source}, 'unknown')`);
  return rows;
}

/* ------------------------------------------------- lead generation + calling */

/**
 * The lead-generation funnel, counted from the records themselves.
 *
 * Every stage after discovery counts the same population — contacts promoted
 * from a discovery record in this range — so the stages are comparable to each
 * other. Mixing search-job totals with all-contacts counts produced a funnel
 * that widened halfway down, which is worse than no funnel.
 *
 * "Crawled" counts crawls attempted, not crawls that succeeded: a site that
 * will not load is a finding about the business, and the lead still progresses.
 */
export async function leadFunnel(ctx: Ctx, range: DateRange) {
  const db = getDb();

  const searchRows = await db
    .select({
      searches: sql<number>`count(*)::int`,
      discovered: sql<number>`coalesce(sum(${leadSearchJobs.discoveredCount}), 0)::int`,
      unique: sql<number>`coalesce(sum(${leadSearchJobs.uniqueCount}), 0)::int`,
      duplicates: sql<number>`coalesce(sum(${leadSearchJobs.duplicateCount}), 0)::int`,
      failed: sql<number>`coalesce(sum(${leadSearchJobs.failedCount}), 0)::int`,
    })
    .from(leadSearchJobs)
    .where(
      and(
        eq(leadSearchJobs.organizationId, ctx.organizationId),
        gte(leadSearchJobs.createdAt, range.from),
        lte(leadSearchJobs.createdAt, range.to),
      ),
    );

  const stageRows = await db
    .select({
      promoted: sql<number>`count(*)::int`,
      crawled: sql<number>`count(*) filter (where exists (
        select 1 from ${leadEnrichment} le
        where le.company_id = ${outer(companies.id)} and le.kind = 'website'
      ))::int`,
      researched: sql<number>`count(*) filter (where ${companies.researchedAt} is not null)::int`,
      scored: sql<number>`count(*) filter (where ${contacts.score} is not null)::int`,
      personalized: sql<number>`count(*) filter (where exists (
        select 1 from ${leadPersonalization} lp where lp.contact_id = ${outer(contacts.id)}
      ))::int`,
      callReady: sql<number>`count(*) filter (where ${contacts.callReadiness} in ('READY','QUEUED'))::int`,
      called: sql<number>`count(*) filter (where exists (
        select 1 from ${callAttempts} ca where ca.contact_id = ${outer(contacts.id)}
      ))::int`,
    })
    .from(contacts)
    .innerJoin(leadDiscoveryRecords, eq(leadDiscoveryRecords.contactId, contacts.id))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        gte(contacts.createdAt, range.from),
        lte(contacts.createdAt, range.to),
      ),
    );

  const s = searchRows[0];
  const t = stageRows[0];

  return {
    searches: s?.searches ?? 0,
    discovered: s?.discovered ?? 0,
    duplicates: s?.duplicates ?? 0,
    failed: s?.failed ?? 0,
    promoted: t?.promoted ?? 0,
    crawled: t?.crawled ?? 0,
    researched: t?.researched ?? 0,
    scored: t?.scored ?? 0,
    personalized: t?.personalized ?? 0,
    callReady: t?.callReady ?? 0,
    called: t?.called ?? 0,
  };
}

/** Call outcomes in a range, for the outcome breakdown. */
export async function callOutcomeBreakdown(ctx: Ctx, range: DateRange) {
  const rows = await getDb()
    .select({ outcome: callAttempts.outcome, count: sql<number>`count(*)::int` })
    .from(callAttempts)
    .where(
      and(
        eq(callAttempts.organizationId, ctx.organizationId),
        gte(callAttempts.startedAt, range.from),
        lte(callAttempts.startedAt, range.to),
      ),
    )
    .groupBy(callAttempts.outcome)
    .orderBy(sql`count(*) desc`);

  return rows;
}

/** Calls started and booked per day. */
export async function callsDailySeries(ctx: Ctx, range: DateRange) {
  const rows = await getDb()
    .select({
      day: sql<string>`to_char(${callAttempts.startedAt}, 'YYYY-MM-DD')`,
      started: sql<number>`count(*)::int`,
      booked: sql<number>`count(*) filter (where ${callAttempts.outcome} = 'BOOKED')::int`,
      dispositioned: sql<number>`count(*) filter (where ${callAttempts.outcome} <> 'INITIATED')::int`,
    })
    .from(callAttempts)
    .where(
      and(
        eq(callAttempts.organizationId, ctx.organizationId),
        gte(callAttempts.startedAt, range.from),
        lte(callAttempts.startedAt, range.to),
      ),
    )
    .groupBy(sql`to_char(${callAttempts.startedAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${callAttempts.startedAt}, 'YYYY-MM-DD')`);

  return rows;
}
