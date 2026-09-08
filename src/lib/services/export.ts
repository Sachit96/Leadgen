import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  activities,
  appointments,
  companies,
  contacts,
  conversations,
  messages,
  pipelineDeals,
} from '@/lib/db/schema';
import { toCsv } from '@/lib/core/csv';
import { formatPhone } from '@/lib/core/phone';
import { listProspects, type ProspectFilters } from './contacts';
import { campaignPerformance, resolveRange, variantPerformance } from './analytics';
import { STAGE_LABELS } from './pipeline';
import type { Ctx } from '@/lib/auth/context';

export type ExportKind =
  | 'prospects'
  | 'conversations'
  | 'campaign_analytics'
  | 'variant_analytics'
  | 'pipeline'
  | 'appointments'
  | 'activities';

export type ExportFile = { filename: string; content: string; contentType: 'text/csv' };

/** Exports respect the same filters as the screen the operator is looking at. */
export async function exportCsv(
  ctx: Ctx,
  kind: ExportKind,
  options: { filters?: ProspectFilters; range?: string } = {},
): Promise<ExportFile> {
  const stamp = new Date().toISOString().slice(0, 10);

  switch (kind) {
    case 'prospects': {
      const page = await listProspects(ctx, { filters: options.filters, pageSize: 200, page: 1 });
      const rows: Array<Record<string, unknown>> = [];
      const pageCount = Math.min(page.pageCount, 50);
      for (let p = 1; p <= pageCount; p += 1) {
        const chunk = p === 1 ? page : await listProspects(ctx, { filters: options.filters, pageSize: 200, page: p });
        rows.push(
          ...chunk.rows.map((r) => ({
            first_name: r.firstName,
            last_name: r.lastName,
            company: r.companyName,
            phone: r.phone,
            phone_formatted: formatPhone(r.phone),
            email: r.email,
            city: r.companyCity,
            province: r.companyProvince,
            industry: r.companyIndustry,
            website: r.companyWebsite,
            google_reviews: r.companyReviews,
            google_rating: r.companyRating,
            owner: r.companyOwner,
            campaign: r.campaignName,
            on_radar_score: r.score,
            score_bucket: r.scoreBucket,
            status: r.status,
            last_activity: r.lastActivityAt,
            next_action: r.nextAction,
            next_action_at: r.nextActionAt,
            created_at: r.createdAt,
          })),
        );
      }
      return file(`prospects-${stamp}.csv`, toCsv(rows));
    }

    case 'conversations': {
      const rows = await getDb()
        .select({
          createdAt: messages.createdAt,
          direction: messages.direction,
          author: messages.author,
          status: messages.status,
          body: messages.body,
          phone: contacts.phone,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          company: companies.name,
          state: conversations.state,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(contacts, eq(contacts.id, messages.contactId))
        .leftJoin(companies, eq(companies.id, contacts.companyId))
        .where(eq(messages.organizationId, ctx.organizationId))
        .orderBy(asc(messages.createdAt))
        .limit(20_000);

      return file(
        `conversations-${stamp}.csv`,
        toCsv(
          rows.map((r) => ({
            timestamp: r.createdAt,
            company: r.company,
            contact: [r.firstName, r.lastName].filter(Boolean).join(' '),
            phone: r.phone,
            direction: r.direction,
            author: r.author,
            status: r.status,
            conversation_state: r.state,
            message: r.body,
          })),
        ),
      );
    }

    case 'campaign_analytics': {
      const range = resolveRange(options.range);
      const rows = await campaignPerformance(ctx, range);
      return file(
        `campaign-analytics-${stamp}.csv`,
        toCsv(
          rows.map((r) => ({
            campaign: r.campaignName,
            status: r.status,
            prospects: r.prospects,
            sent: r.sent,
            delivered: r.delivered,
            replies: r.replies,
            reply_rate_pct: r.replyRate,
            positive_replies: r.positiveReplies,
            appointments: r.appointments,
            booking_rate_pct: r.bookingRate,
            deals_won: r.won,
            revenue_cents: r.revenueCents,
            revenue_per_100_prospects_cents: r.revenuePer100Prospects,
          })),
        ),
      );
    }

    case 'variant_analytics': {
      const rows = await variantPerformance(ctx);
      return file(
        `variant-analytics-${stamp}.csv`,
        toCsv(
          rows.map((r) => ({
            campaign: r.campaignName,
            variant: r.variantName,
            angle: r.angle,
            messages: r.messages,
            replies: r.replies,
            reply_rate_pct: r.replyRate,
            positive_replies: r.positiveReplies,
            positive_rate_pct: r.positiveRate,
            qualified: r.qualified,
            appointments: r.appointments,
            revenue_cents: r.revenueCents,
            sample_is_significant: r.significant,
          })),
        ),
      );
    }

    case 'pipeline': {
      const rows = await getDb()
        .select({
          deal: pipelineDeals,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          phone: contacts.phone,
          company: companies.name,
        })
        .from(pipelineDeals)
        .innerJoin(contacts, eq(contacts.id, pipelineDeals.contactId))
        .leftJoin(companies, eq(companies.id, contacts.companyId))
        .where(eq(pipelineDeals.organizationId, ctx.organizationId))
        .orderBy(desc(pipelineDeals.updatedAt));

      return file(
        `pipeline-${stamp}.csv`,
        toCsv(
          rows.map((r) => ({
            title: r.deal.title,
            company: r.company,
            contact: [r.firstName, r.lastName].filter(Boolean).join(' '),
            phone: r.phone,
            stage: STAGE_LABELS[r.deal.stage],
            value_cents: r.deal.valueCents,
            recurring_value_cents: r.deal.recurringValueCents,
            created_at: r.deal.createdAt,
            won_at: r.deal.wonAt,
            lost_at: r.deal.lostAt,
            lost_reason: r.deal.lostReason,
          })),
        ),
      );
    }

    case 'appointments': {
      const rows = await getDb()
        .select({ appointment: appointments, contact: contacts, company: companies.name })
        .from(appointments)
        .innerJoin(contacts, eq(contacts.id, appointments.contactId))
        .leftJoin(companies, eq(companies.id, contacts.companyId))
        .where(eq(appointments.organizationId, ctx.organizationId))
        .orderBy(desc(appointments.startsAt));

      return file(
        `appointments-${stamp}.csv`,
        toCsv(
          rows.map((r) => ({
            title: r.appointment.title,
            company: r.company,
            contact: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' '),
            phone: r.contact.phone,
            starts_at: r.appointment.startsAt,
            ends_at: r.appointment.endsAt,
            timezone: r.appointment.timezone,
            status: r.appointment.status,
            notes: r.appointment.notes,
          })),
        ),
      );
    }

    case 'activities': {
      const rows = await getDb()
        .select({ activity: activities, phone: contacts.phone, company: companies.name })
        .from(activities)
        .leftJoin(contacts, eq(contacts.id, activities.contactId))
        .leftJoin(companies, eq(companies.id, contacts.companyId))
        .where(eq(activities.organizationId, ctx.organizationId))
        .orderBy(desc(activities.createdAt))
        .limit(20_000);

      return file(
        `activities-${stamp}.csv`,
        toCsv(
          rows.map((r) => ({
            timestamp: r.activity.createdAt,
            type: r.activity.type,
            title: r.activity.title,
            body: r.activity.body,
            company: r.company,
            phone: r.phone,
            actor: r.activity.actorKind,
          })),
        ),
      );
    }

    default:
      return file(`export-${stamp}.csv`, '');
  }
}

function file(filename: string, content: string): ExportFile {
  return { filename, content, contentType: 'text/csv' };
}

/** Guards the export route against a filter that would scan the whole table. */
export async function exportCount(ctx: Ctx, filters?: ProspectFilters): Promise<number> {
  const page = await listProspects(ctx, { filters, pageSize: 10, page: 1 });
  return page.total;
}
