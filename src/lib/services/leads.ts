import { and, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  callAttempts,
  companies,
  contacts,
  duplicateMatches,
  leadDiscoveryRecords,
  leadEnrichment,
  leadPersonalization,
  leadSignals,
} from '@/lib/db/schema';
import { invalid, notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import type { Ctx } from '@/lib/auth/context';
import { recordActivity } from './activity';
import { enqueueLeadJob } from './lead-jobs';
import { refreshCallReadiness } from './lead-pipeline';

/**
 * The lead inbox — a view over the CRM, not a second prospect store.
 *
 * Every row here is a `contacts` row joined to its company and its lead-gen
 * state. Approving a lead does not move it anywhere; it marks it ready to work.
 */
export type LeadView =
  | 'ALL'
  | 'NEW'
  | 'ENRICHING'
  | 'ENRICHED'
  | 'REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'DUPLICATES'
  | 'CAMPAIGN_READY'
  | 'CALL_READY';

export type LeadFilters = {
  view?: LeadView;
  search?: string;
  minScore?: number;
  buckets?: string[];
  industries?: string[];
  cities?: string[];
  searchJobId?: string;
  requireOwner?: boolean;
  requirePhone?: boolean;
  requireWebsite?: boolean;
};

export type LeadRow = {
  contactId: string;
  companyId: string | null;
  companyName: string | null;
  contactName: string | null;
  city: string | null;
  category: string | null;
  phone: string;
  website: string | null;
  reviews: number | null;
  rating: number | null;
  score: number | null;
  scoreBucket: string | null;
  completeness: number | null;
  enrichedAt: Date | null;
  callReadiness: string;
  lastCallOutcome: string | null;
  status: string;
  stage: string | null;
  hasPersonalization: boolean;
  isDemo: boolean;
  lastActivityAt: Date | null;
};

function viewClauses(view: LeadView): SQL[] {
  switch (view) {
    case 'NEW':
      return [eq(contacts.status, 'NEW'), isNull(companies.enrichedAt)];
    case 'ENRICHING':
      return [sql`${leadDiscoveryRecords.stage} in ('NORMALIZED','ENRICHING')`];
    case 'ENRICHED':
      return [isNotNull(companies.enrichedAt)];
    case 'REVIEW':
      return [sql`${leadDiscoveryRecords.stage} = 'REVIEW'`];
    case 'APPROVED':
      return [sql`${leadDiscoveryRecords.stage} = 'APPROVED'`];
    case 'REJECTED':
      return [sql`${leadDiscoveryRecords.stage} = 'REJECTED'`];
    case 'DUPLICATES':
      return [sql`${leadDiscoveryRecords.stage} = 'DUPLICATE'`];
    case 'CAMPAIGN_READY':
      return [
        sql`exists (select 1 from ${leadPersonalization} lp where lp.contact_id = ${contacts.id})`,
        sql`${contacts.status} not in ('DO_NOT_CONTACT','LOST')`,
      ];
    case 'CALL_READY':
      return [sql`${contacts.callReadiness} in ('READY','QUEUED')`];
    default:
      return [];
  }
}

export async function listLeads(
  ctx: Ctx,
  options: { filters?: LeadFilters; page?: number; pageSize?: number } = {},
): Promise<{ rows: LeadRow[]; total: number; page: number; pageCount: number }> {
  const filters = options.filters ?? {};
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, options.pageSize ?? 50));
  const db = getDb();

  const clauses: SQL[] = [eq(contacts.organizationId, ctx.organizationId)];
  clauses.push(...viewClauses(filters.view ?? 'ALL'));

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    clauses.push(sql`(${companies.name} ilike ${term} or ${contacts.phone} ilike ${term} or ${companies.city} ilike ${term})`);
  }
  if (filters.minScore !== undefined) clauses.push(gte(contacts.score, filters.minScore));
  if (filters.buckets?.length) clauses.push(inArray(contacts.scoreBucket, filters.buckets));
  if (filters.industries?.length) clauses.push(inArray(companies.industry, filters.industries));
  if (filters.cities?.length) clauses.push(inArray(companies.city, filters.cities));
  if (filters.searchJobId) clauses.push(eq(leadDiscoveryRecords.searchJobId, filters.searchJobId));
  if (filters.requireOwner) clauses.push(isNotNull(companies.ownerName));
  if (filters.requireWebsite) clauses.push(isNotNull(companies.website));

  const base = db
    .select({
      contactId: contacts.id,
      companyId: companies.id,
      companyName: companies.name,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      city: companies.city,
      category: companies.industry,
      phone: contacts.phone,
      website: companies.website,
      reviews: companies.googleReviews,
      rating: companies.googleRating,
      score: contacts.score,
      scoreBucket: contacts.scoreBucket,
      completeness: companies.dataCompleteness,
      enrichedAt: companies.enrichedAt,
      callReadiness: contacts.callReadiness,
      lastCallOutcome: contacts.lastCallOutcome,
      status: contacts.status,
      stage: leadDiscoveryRecords.stage,
      isDemo: contacts.isDemo,
      lastActivityAt: contacts.lastActivityAt,
      hasPersonalization: sql<boolean>`exists (
        select 1 from ${leadPersonalization} lp where lp.contact_id = ${contacts.id}
      )`,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(leadDiscoveryRecords, eq(leadDiscoveryRecords.contactId, contacts.id))
    .where(and(...clauses));

  const rows = await base
    .orderBy(sql`${contacts.score} desc nulls last`, desc(contacts.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(leadDiscoveryRecords, eq(leadDiscoveryRecords.contactId, contacts.id))
    .where(and(...clauses));

  const total = countRows[0]?.count ?? 0;

  return {
    rows: rows.map((r) => ({
      ...r,
      contactName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Counts for the view tabs, in one query rather than one per tab. */
export async function leadViewCounts(ctx: Ctx): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({
      all: sql<number>`count(*)::int`,
      enriched: sql<number>`count(*) filter (where ${companies.enrichedAt} is not null)::int`,
      review: sql<number>`count(*) filter (where ${leadDiscoveryRecords.stage} = 'REVIEW')::int`,
      approved: sql<number>`count(*) filter (where ${leadDiscoveryRecords.stage} = 'APPROVED')::int`,
      rejected: sql<number>`count(*) filter (where ${leadDiscoveryRecords.stage} = 'REJECTED')::int`,
      duplicates: sql<number>`count(*) filter (where ${leadDiscoveryRecords.stage} = 'DUPLICATE')::int`,
      callReady: sql<number>`count(*) filter (where ${contacts.callReadiness} in ('READY','QUEUED'))::int`,
      campaignReady: sql<number>`count(*) filter (where exists (
        select 1 from ${leadPersonalization} lp where lp.contact_id = ${contacts.id}
      ))::int`,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(leadDiscoveryRecords, eq(leadDiscoveryRecords.contactId, contacts.id))
    .where(eq(contacts.organizationId, ctx.organizationId));

  const r = rows[0];
  return {
    ALL: r?.all ?? 0,
    ENRICHED: r?.enriched ?? 0,
    REVIEW: r?.review ?? 0,
    APPROVED: r?.approved ?? 0,
    REJECTED: r?.rejected ?? 0,
    DUPLICATES: r?.duplicates ?? 0,
    CALL_READY: r?.callReady ?? 0,
    CAMPAIGN_READY: r?.campaignReady ?? 0,
  };
}

/** Everything the review screen and the admin debug view need. */
export async function getLeadDetail(ctx: Ctx, contactId: string) {
  const db = getDb();

  const rows = await db
    .select({ contact: contacts, company: companies, discovery: leadDiscoveryRecords })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(leadDiscoveryRecords, eq(leadDiscoveryRecords.contactId, contacts.id))
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Lead');

  const companyId = row.company?.id;
  const [signals, enrichment, personalization, duplicates, calls] = await Promise.all([
    companyId ? db.select().from(leadSignals).where(eq(leadSignals.companyId, companyId)) : [],
    companyId
      ? db
          .select()
          .from(leadEnrichment)
          .where(eq(leadEnrichment.companyId, companyId))
          .orderBy(desc(leadEnrichment.createdAt))
          .limit(5)
      : [],
    db
      .select()
      .from(leadPersonalization)
      .where(eq(leadPersonalization.contactId, contactId))
      .orderBy(desc(leadPersonalization.createdAt))
      .limit(1),
    companyId
      ? db.select().from(duplicateMatches).where(eq(duplicateMatches.matchedCompanyId, companyId)).limit(10)
      : [],
    db
      .select()
      .from(callAttempts)
      .where(eq(callAttempts.contactId, contactId))
      .orderBy(desc(callAttempts.startedAt))
      .limit(20),
  ]);

  return {
    contact: row.contact,
    company: row.company,
    discovery: row.discovery,
    signals,
    enrichment,
    personalization: personalization[0] ?? null,
    duplicates,
    calls,
  };
}

export async function approveLeads(ctx: Ctx, contactIds: string[]): Promise<number> {
  assertCan(ctx.role, 'prospect:write');
  if (contactIds.length === 0) return 0;
  const db = getDb();

  await db
    .update(leadDiscoveryRecords)
    .set({ stage: 'APPROVED' })
    .where(
      and(
        eq(leadDiscoveryRecords.organizationId, ctx.organizationId),
        inArray(leadDiscoveryRecords.contactId, contactIds),
      ),
    );

  await db
    .update(contacts)
    .set({ status: 'READY', updatedAt: new Date() })
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        inArray(contacts.id, contactIds),
        eq(contacts.status, 'NEW'),
      ),
    );

  for (const contactId of contactIds) {
    await refreshCallReadiness(ctx, contactId);
    await recordActivity(ctx, {
      type: 'lead_approved',
      title: 'Lead approved',
      contactId,
    });
  }

  return contactIds.length;
}

export async function rejectLeads(ctx: Ctx, contactIds: string[], reason?: string): Promise<number> {
  assertCan(ctx.role, 'prospect:write');
  if (contactIds.length === 0) return 0;
  const db = getDb();

  await db
    .update(leadDiscoveryRecords)
    .set({ stage: 'REJECTED' })
    .where(
      and(
        eq(leadDiscoveryRecords.organizationId, ctx.organizationId),
        inArray(leadDiscoveryRecords.contactId, contactIds),
      ),
    );

  // Rejected means "not worth working", not "do not contact" — the record
  // stays and can be revisited.
  await db
    .update(contacts)
    .set({ callReadiness: 'NOT_READY', updatedAt: new Date() })
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, contactIds)));

  for (const contactId of contactIds) {
    await recordActivity(ctx, {
      type: 'lead_rejected',
      title: 'Lead rejected',
      body: reason ?? null,
      contactId,
    });
  }

  return contactIds.length;
}

/** Re-runs a stage for one lead. Used by the refresh actions on review. */
export async function requeueStage(
  ctx: Ctx,
  contactId: string,
  stage: 'website_enrichment' | 'ai_research' | 'lead_scoring' | 'personalization_generation',
): Promise<void> {
  assertCan(ctx.role, 'prospect:write');
  const db = getDb();

  const rows = await db
    .select({ companyId: contacts.companyId })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const companyId = rows[0]?.companyId;
  if (!companyId && stage !== 'lead_scoring' && stage !== 'personalization_generation') {
    throw invalid('This lead has no company to enrich');
  }

  // A fresh key each time, so a manual refresh is never deduped away.
  await enqueueLeadJob(ctx, {
    type: stage,
    idempotencyKey: `${stage}:${contactId}:${Date.now()}`,
    companyId: companyId ?? null,
    contactId,
    priority: 1,
  });
}
