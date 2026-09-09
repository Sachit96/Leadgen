import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leadJobs } from '@/lib/db/schema';
import type { Ctx } from '@/lib/auth/context';
import type { LeadJobType } from '@/lib/constants/enums';

/**
 * The lead pipeline's job queue.
 *
 * Separate from `outbound_jobs`, which is SMS-specific — its `message_id` and
 * `conversation_id` are NOT NULL — but built the same way: rows claimed with
 * `FOR UPDATE SKIP LOCKED`, a unique idempotency key per organization, and
 * exponential backoff. Both are drained by the same worker tick.
 */
export type EnqueueLeadJob = {
  type: LeadJobType;
  /** Duplicate keys are a no-op, so a retried enqueue cannot double-run. */
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  searchJobId?: string | null;
  discoveryRecordId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  /** Lower runs first. Discovery leads, personalization trails. */
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
};

export type ClaimedLeadJob = {
  id: string;
  organizationId: string;
  type: LeadJobType;
  payload: Record<string, unknown>;
  searchJobId: string | null;
  discoveryRecordId: string | null;
  companyId: string | null;
  contactId: string | null;
  attempts: number;
  maxAttempts: number;
};

/** Returns null when the key was already enqueued. */
export async function enqueueLeadJob(ctx: Ctx, input: EnqueueLeadJob): Promise<string | null> {
  const rows = await getDb()
    .insert(leadJobs)
    .values({
      organizationId: ctx.organizationId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      searchJobId: input.searchJobId ?? null,
      discoveryRecordId: input.discoveryRecordId ?? null,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
      priority: input.priority ?? 5,
      scheduledAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
    })
    .onConflictDoNothing({ target: [leadJobs.organizationId, leadJobs.idempotencyKey] })
    .returning({ id: leadJobs.id });
  return rows[0]?.id ?? null;
}

export async function enqueueMany(ctx: Ctx, jobs: EnqueueLeadJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const rows = await getDb()
    .insert(leadJobs)
    .values(
      jobs.map((job) => ({
        organizationId: ctx.organizationId,
        type: job.type,
        idempotencyKey: job.idempotencyKey,
        payload: job.payload ?? {},
        searchJobId: job.searchJobId ?? null,
        discoveryRecordId: job.discoveryRecordId ?? null,
        companyId: job.companyId ?? null,
        contactId: job.contactId ?? null,
        priority: job.priority ?? 5,
        scheduledAt: job.runAt ?? new Date(),
        maxAttempts: job.maxAttempts ?? 3,
      })),
    )
    .onConflictDoNothing({ target: [leadJobs.organizationId, leadJobs.idempotencyKey] })
    .returning({ id: leadJobs.id });
  return rows.length;
}

const STUCK_AFTER_MINUTES = 15;

/** Claims due jobs, releasing any stranded by a crashed worker first. */
export async function claimLeadJobs(limit: number, workerId: string): Promise<ClaimedLeadJob[]> {
  const db = getDb();

  await db
    .update(leadJobs)
    .set({ status: 'PENDING', lockedAt: null, lockedBy: null })
    .where(
      and(
        eq(leadJobs.status, 'RUNNING'),
        lt(leadJobs.lockedAt, new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000)),
      ),
    );

  const result = await db.execute(sql`
    update lead_jobs
       set status = 'RUNNING',
           locked_at = now(),
           locked_by = ${workerId},
           started_at = now(),
           attempts = attempts + 1
     where id in (
       select id from lead_jobs
        where status = 'PENDING' and scheduled_at <= now()
        order by priority, scheduled_at
        limit ${limit}
        for update skip locked
     )
    returning id, organization_id, type, payload, search_job_id, discovery_record_id,
              company_id, contact_id, attempts, max_attempts
  `);

  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  return rows.map((r) => ({
    id: String(r.id),
    organizationId: String(r.organization_id),
    type: r.type as LeadJobType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    searchJobId: r.search_job_id ? String(r.search_job_id) : null,
    discoveryRecordId: r.discovery_record_id ? String(r.discovery_record_id) : null,
    companyId: r.company_id ? String(r.company_id) : null,
    contactId: r.contact_id ? String(r.contact_id) : null,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function completeLeadJob(jobId: string): Promise<void> {
  await getDb()
    .update(leadJobs)
    .set({ status: 'SUCCEEDED', completedAt: new Date(), lockedAt: null, lockedBy: null, error: null })
    .where(eq(leadJobs.id, jobId));
}

/** A lead that legitimately has nothing to do — no website to crawl, say. */
export async function skipLeadJob(jobId: string, reason: string): Promise<void> {
  await getDb()
    .update(leadJobs)
    .set({ status: 'SKIPPED', completedAt: new Date(), error: reason, lockedAt: null, lockedBy: null })
    .where(eq(leadJobs.id, jobId));
}

/** 1m, 2m, 4m … capped at 15 minutes. */
export function leadBackoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export async function failLeadJob(
  job: ClaimedLeadJob,
  error: string,
  options: { retryable?: boolean; code?: string } = {},
): Promise<'retrying' | 'dead'> {
  const retryable = options.retryable ?? true;
  const exhausted = !retryable || job.attempts >= job.maxAttempts;

  await getDb()
    .update(leadJobs)
    .set({
      status: exhausted ? 'DEAD' : 'PENDING',
      error: error.slice(0, 1000),
      errorCode: options.code ?? null,
      lockedAt: null,
      lockedBy: null,
      scheduledAt: exhausted ? new Date() : new Date(Date.now() + leadBackoffMs(job.attempts)),
      completedAt: exhausted ? new Date() : null,
    })
    .where(eq(leadJobs.id, job.id));

  return exhausted ? 'dead' : 'retrying';
}

export async function cancelJobsForSearch(searchJobId: string): Promise<number> {
  const rows = await getDb()
    .update(leadJobs)
    .set({ status: 'CANCELLED', completedAt: new Date() })
    .where(and(eq(leadJobs.searchJobId, searchJobId), eq(leadJobs.status, 'PENDING')))
    .returning({ id: leadJobs.id });
  return rows.length;
}

/** Per-type counts, for the pipeline progress display. */
export async function leadJobStats(ctx: Ctx, searchJobId?: string) {
  const clauses = [eq(leadJobs.organizationId, ctx.organizationId)];
  if (searchJobId) clauses.push(eq(leadJobs.searchJobId, searchJobId));

  return getDb()
    .select({
      type: leadJobs.type,
      status: leadJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leadJobs)
    .where(and(...clauses))
    .groupBy(leadJobs.type, leadJobs.status);
}

export async function retryDeadLeadJobs(ctx: Ctx, searchJobId?: string): Promise<number> {
  const clauses = [eq(leadJobs.organizationId, ctx.organizationId), eq(leadJobs.status, 'DEAD')];
  if (searchJobId) clauses.push(eq(leadJobs.searchJobId, searchJobId));

  const rows = await getDb()
    .update(leadJobs)
    .set({ status: 'PENDING', attempts: 0, scheduledAt: new Date(), error: null, completedAt: null })
    .where(and(...clauses))
    .returning({ id: leadJobs.id });
  return rows.length;
}
