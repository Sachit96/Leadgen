import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { outboundJobs } from '@/lib/db/schema';
import type { Ctx } from '@/lib/auth/context';

/**
 * Durable outbound queue, backed by Postgres.
 *
 * The brief forbids sending from a UI request, and a second datastore would be
 * infrastructure for its own sake at this volume. `FOR UPDATE SKIP LOCKED`
 * gives us exactly-once claiming across any number of workers, and the unique
 * `(organization_id, idempotency_key)` index makes double-enqueue a no-op
 * rather than a duplicate text to a prospect.
 */
export type ClaimedJob = {
  id: string;
  organizationId: string;
  messageId: string;
  conversationId: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
};

export type EnqueueInput = {
  messageId: string;
  conversationId: string;
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
};

/** Returns null when the idempotency key has already been enqueued. */
export async function enqueue(ctx: Ctx, input: EnqueueInput): Promise<string | null> {
  const rows = await getDb()
    .insert(outboundJobs)
    .values({
      organizationId: ctx.organizationId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: [outboundJobs.organizationId, outboundJobs.idempotencyKey] })
    .returning({ id: outboundJobs.id });
  return rows[0]?.id ?? null;
}

const STUCK_AFTER_MINUTES = 10;

/**
 * Claims up to `limit` due jobs for this worker. Jobs left PROCESSING by a
 * crashed worker are released first, so a restart does not strand them.
 */
export async function claimJobs(limit: number, workerId: string): Promise<ClaimedJob[]> {
  const db = getDb();

  await db
    .update(outboundJobs)
    .set({ status: 'PENDING', lockedAt: null, lockedBy: null })
    .where(
      and(
        eq(outboundJobs.status, 'PROCESSING'),
        lt(outboundJobs.lockedAt, new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000)),
      ),
    );

  const result = await db.execute(sql`
    update outbound_jobs
       set status = 'PROCESSING',
           locked_at = now(),
           locked_by = ${workerId},
           attempts = attempts + 1
     where id in (
       select id from outbound_jobs
        where status = 'PENDING' and run_at <= now()
        order by run_at
        limit ${limit}
        for update skip locked
     )
    returning id, organization_id, message_id, conversation_id, attempts, max_attempts, idempotency_key
  `);

  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  return rows.map((r) => ({
    id: String(r.id),
    organizationId: String(r.organization_id),
    messageId: String(r.message_id),
    conversationId: String(r.conversation_id),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    idempotencyKey: String(r.idempotency_key),
  }));
}

export async function completeJob(jobId: string): Promise<void> {
  await getDb()
    .update(outboundJobs)
    .set({ status: 'SUCCEEDED', completedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null })
    .where(eq(outboundJobs.id, jobId));
}

/** 30s, 1m, 2m, 4m, 8m — capped at 30 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export type FailOutcome = 'retrying' | 'dead';

export async function failJob(
  job: ClaimedJob,
  error: string,
  retryable: boolean,
): Promise<FailOutcome> {
  const exhausted = !retryable || job.attempts >= job.maxAttempts;

  await getDb()
    .update(outboundJobs)
    .set({
      status: exhausted ? 'DEAD' : 'PENDING',
      lastError: error.slice(0, 1000),
      lockedAt: null,
      lockedBy: null,
      runAt: exhausted ? new Date() : new Date(Date.now() + backoffMs(job.attempts)),
      completedAt: exhausted ? new Date() : null,
    })
    .where(eq(outboundJobs.id, job.id));

  return exhausted ? 'dead' : 'retrying';
}

/** Requeues a job that stopped early because a guardrail was not yet clear. */
export async function deferJob(jobId: string, runAt: Date, reason: string): Promise<void> {
  await getDb()
    .update(outboundJobs)
    .set({
      status: 'PENDING',
      runAt,
      lockedAt: null,
      lockedBy: null,
      lastError: `deferred: ${reason}`,
      attempts: sql`greatest(0, ${outboundJobs.attempts} - 1)`,
    })
    .where(eq(outboundJobs.id, jobId));
}

export async function cancelJob(jobId: string, reason: string): Promise<void> {
  await getDb()
    .update(outboundJobs)
    .set({ status: 'CANCELLED', lastError: reason, completedAt: new Date(), lockedAt: null, lockedBy: null })
    .where(eq(outboundJobs.id, jobId));
}

export async function cancelJobsForConversation(conversationId: string, reason: string): Promise<number> {
  const rows = await getDb()
    .update(outboundJobs)
    .set({ status: 'CANCELLED', lastError: reason, completedAt: new Date() })
    .where(
      and(eq(outboundJobs.conversationId, conversationId), eq(outboundJobs.status, 'PENDING')),
    )
    .returning({ id: outboundJobs.id });
  return rows.length;
}

export async function queueStats(ctx: Ctx) {
  const rows = await getDb()
    .select({ status: outboundJobs.status, count: sql<number>`count(*)::int` })
    .from(outboundJobs)
    .where(eq(outboundJobs.organizationId, ctx.organizationId))
    .groupBy(outboundJobs.status);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return {
    pending: byStatus.PENDING ?? 0,
    processing: byStatus.PROCESSING ?? 0,
    succeeded: byStatus.SUCCEEDED ?? 0,
    failed: byStatus.FAILED ?? 0,
    dead: byStatus.DEAD ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
  };
}

/** Dead-letter view for the settings screen. */
export async function listDeadJobs(ctx: Ctx, limit = 50) {
  return getDb()
    .select()
    .from(outboundJobs)
    .where(and(eq(outboundJobs.organizationId, ctx.organizationId), eq(outboundJobs.status, 'DEAD')))
    .orderBy(sql`${outboundJobs.completedAt} desc nulls last`)
    .limit(limit);
}

export async function retryDeadJob(ctx: Ctx, jobId: string): Promise<void> {
  await getDb()
    .update(outboundJobs)
    .set({ status: 'PENDING', attempts: 0, runAt: new Date(), lastError: null, completedAt: null })
    .where(
      and(
        eq(outboundJobs.id, jobId),
        eq(outboundJobs.organizationId, ctx.organizationId),
        eq(outboundJobs.status, 'DEAD'),
      ),
    );
}
