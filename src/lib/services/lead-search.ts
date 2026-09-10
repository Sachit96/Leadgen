import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leadDiscoveryRecords, leadSearchJobs, savedSearches } from '@/lib/db/schema';
import { invalid, notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import type { Ctx } from '@/lib/auth/context';
import type { LeadSearchJob, SavedSearch } from '@/lib/db/types';
import type { SearchFilters } from '@/lib/lead-generation/providers/types';
import { getDiscoveryProvider } from '@/lib/lead-generation/providers';
import { enqueueLeadJob } from './lead-jobs';
import { recordActivity } from './activity';

export type CreateSearchInput = {
  query: string;
  location: string;
  radiusMeters?: number;
  requestedCount?: number;
  filters?: SearchFilters;
  savedSearchId?: string | null;
};

/** Hard ceiling per job, so one search cannot run up an unbounded bill. */
const MAX_REQUESTED = 500;

export async function createSearchJob(ctx: Ctx, input: CreateSearchInput): Promise<LeadSearchJob> {
  assertCan(ctx.role, 'prospect:import');

  const query = input.query.trim();
  const location = input.location.trim();
  if (!query) throw invalid('Enter an industry or keyword to search for');
  if (!location) throw invalid('Enter a location to search in');

  const provider = getDiscoveryProvider();
  const [job] = await getDb()
    .insert(leadSearchJobs)
    .values({
      organizationId: ctx.organizationId,
      savedSearchId: input.savedSearchId ?? null,
      query,
      location,
      radiusMeters: input.radiusMeters ?? 25_000,
      requestedCount: Math.min(MAX_REQUESTED, Math.max(1, input.requestedCount ?? 100)),
      filters: input.filters ?? {},
      provider: provider.kind,
      status: 'DRAFT',
      createdByUserId: ctx.user?.userId ?? null,
    })
    .returning();

  return job!;
}

/** Moves a draft to QUEUED and enqueues the discovery job the worker runs. */
export async function startSearchJob(ctx: Ctx, searchJobId: string): Promise<LeadSearchJob> {
  assertCan(ctx.role, 'prospect:import');
  const job = await getSearchJob(ctx, searchJobId);

  if (job.status === 'RUNNING' || job.status === 'QUEUED') return job;
  if (job.status === 'COMPLETED') throw invalid('That search has already finished. Duplicate it to run again.');

  const [updated] = await getDb()
    .update(leadSearchJobs)
    .set({ status: 'QUEUED', startedAt: new Date(), error: null })
    .where(eq(leadSearchJobs.id, searchJobId))
    .returning();

  await enqueueLeadJob(ctx, {
    type: 'lead_discovery',
    idempotencyKey: `discovery:${searchJobId}`,
    searchJobId,
    priority: 1,
  });

  await recordActivity(ctx, {
    type: 'discovery_started',
    title: `Search started: ${job.query} in ${job.location}`,
    metadata: { searchJobId, provider: job.provider, requested: job.requestedCount },
  });

  return updated!;
}

export async function cancelSearchJob(ctx: Ctx, searchJobId: string): Promise<void> {
  assertCan(ctx.role, 'prospect:import');
  const { cancelJobsForSearch } = await import('./lead-jobs');
  await cancelJobsForSearch(searchJobId);
  await getDb()
    .update(leadSearchJobs)
    .set({ status: 'CANCELLED', completedAt: new Date() })
    .where(
      and(eq(leadSearchJobs.id, searchJobId), eq(leadSearchJobs.organizationId, ctx.organizationId)),
    );
}

export async function getSearchJob(ctx: Ctx, id: string): Promise<LeadSearchJob> {
  const rows = await getDb()
    .select()
    .from(leadSearchJobs)
    .where(and(eq(leadSearchJobs.id, id), eq(leadSearchJobs.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Search');
  return row;
}

export async function listSearchJobs(ctx: Ctx, limit = 50) {
  return getDb()
    .select()
    .from(leadSearchJobs)
    .where(eq(leadSearchJobs.organizationId, ctx.organizationId))
    .orderBy(desc(leadSearchJobs.createdAt))
    .limit(limit);
}

/**
 * Increments a counter on the search job.
 *
 * Done as a SQL increment rather than read-modify-write because several
 * enrichment jobs for one search complete concurrently.
 */
export async function bumpSearchCounter(
  searchJobId: string,
  column:
    | 'discoveredCount'
    | 'uniqueCount'
    | 'duplicateCount'
    | 'crawledCount'
    | 'crawlFailedCount'
    | 'qualifiedCount'
    | 'enrichedCount'
    | 'researchedCount'
    | 'scoredCount'
    | 'approvedCount'
    | 'failedCount',
  by = 1,
): Promise<void> {
  const columns = {
    discoveredCount: leadSearchJobs.discoveredCount,
    uniqueCount: leadSearchJobs.uniqueCount,
    duplicateCount: leadSearchJobs.duplicateCount,
    crawledCount: leadSearchJobs.crawledCount,
    crawlFailedCount: leadSearchJobs.crawlFailedCount,
    qualifiedCount: leadSearchJobs.qualifiedCount,
    enrichedCount: leadSearchJobs.enrichedCount,
    researchedCount: leadSearchJobs.researchedCount,
    scoredCount: leadSearchJobs.scoredCount,
    approvedCount: leadSearchJobs.approvedCount,
    failedCount: leadSearchJobs.failedCount,
  } as const;

  const target = columns[column];
  await getDb()
    .update(leadSearchJobs)
    .set({ [column]: sql`${target} + ${by}` })
    .where(eq(leadSearchJobs.id, searchJobId));
}

/**
 * Marks a search complete once nothing is left to do for it.
 *
 * Called after each job finishes; checks for outstanding work rather than
 * assuming, because jobs complete out of order.
 */
export async function completeSearchIfDone(searchJobId: string): Promise<boolean> {
  const db = getDb();
  const { leadJobs } = await import('@/lib/db/schema');

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadJobs)
    .where(
      and(
        eq(leadJobs.searchJobId, searchJobId),
        sql`${leadJobs.status} in ('PENDING','RUNNING')`,
      ),
    );

  if ((rows[0]?.count ?? 0) > 0) return false;

  await db
    .update(leadSearchJobs)
    .set({ status: 'COMPLETED', completedAt: new Date() })
    .where(
      and(eq(leadSearchJobs.id, searchJobId), sql`${leadSearchJobs.status} in ('QUEUED','RUNNING')`),
    );
  return true;
}

/**
 * A run's outcome, counted from the rows it produced.
 *
 * Average score is computed over the leads this search created rather than
 * stored on the job, so a re-score is reflected instead of frozen at the moment
 * the run finished.
 */
export async function searchOutcome(ctx: Ctx, searchJobId: string) {
  const { contacts, leadDiscoveryRecords: records } = await import('@/lib/db/schema');
  const rows = await getDb()
    .select({
      leads: sql<number>`count(*)::int`,
      scored: sql<number>`count(${contacts.score})::int`,
      averageScore: sql<number>`coalesce(round(avg(${contacts.score}))::int, 0)`,
      qualified: sql<number>`count(*) filter (where ${contacts.callReadiness} in ('READY','QUEUED'))::int`,
    })
    .from(records)
    .innerJoin(contacts, eq(contacts.id, records.contactId))
    .where(
      and(
        eq(records.organizationId, ctx.organizationId),
        eq(records.searchJobId, searchJobId),
      ),
    );

  const row = rows[0];
  return {
    leads: row?.leads ?? 0,
    scored: row?.scored ?? 0,
    averageScore: row?.averageScore ?? 0,
    qualified: row?.qualified ?? 0,
  };
}

/** Live progress, counted from the records themselves rather than estimated. */
export async function searchProgress(ctx: Ctx, searchJobId: string) {
  const rows = await getDb()
    .select({ stage: leadDiscoveryRecords.stage, count: sql<number>`count(*)::int` })
    .from(leadDiscoveryRecords)
    .where(
      and(
        eq(leadDiscoveryRecords.organizationId, ctx.organizationId),
        eq(leadDiscoveryRecords.searchJobId, searchJobId),
      ),
    )
    .groupBy(leadDiscoveryRecords.stage);

  return Object.fromEntries(rows.map((r) => [r.stage, r.count])) as Record<string, number>;
}

/* ------------------------------------------------------------ saved searches */

export async function listSavedSearches(ctx: Ctx): Promise<SavedSearch[]> {
  return getDb()
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.organizationId, ctx.organizationId))
    .orderBy(savedSearches.name);
}

export async function saveSearch(
  ctx: Ctx,
  input: { name: string; query: string; location: string; radiusMeters?: number; filters?: SearchFilters },
): Promise<SavedSearch> {
  assertCan(ctx.role, 'prospect:import');
  const [row] = await getDb()
    .insert(savedSearches)
    .values({
      organizationId: ctx.organizationId,
      name: input.name.trim(),
      query: input.query.trim(),
      location: input.location.trim(),
      radiusMeters: input.radiusMeters ?? 25_000,
      filters: input.filters ?? {},
      createdByUserId: ctx.user?.userId ?? null,
    })
    .onConflictDoUpdate({
      target: [savedSearches.organizationId, savedSearches.name],
      set: {
        query: input.query.trim(),
        location: input.location.trim(),
        radiusMeters: input.radiusMeters ?? 25_000,
        filters: input.filters ?? {},
      },
    })
    .returning();
  return row!;
}

export async function deleteSavedSearch(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx.role, 'prospect:import');
  await getDb()
    .delete(savedSearches)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.organizationId, ctx.organizationId)));
}
