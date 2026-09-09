import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { conversations, organizations } from '@/lib/db/schema';
import { logger } from '@/lib/core/logger';
import { errorMessage } from '@/lib/core/errors';
import { runSalesTurn } from '@/lib/agents/sales';
import { systemCtx } from '@/lib/auth/context';
import { dueFollowUps } from '@/lib/services/conversations';
import { claimJobs } from '@/lib/services/queue';
import { processOutboundJob } from '@/lib/services/sender';
import { dueMemberships, processMembership } from '@/lib/services/sequences';
import { sendDueAppointmentReminders } from '@/lib/services/appointments';
import { runLeadJobs, type LeadWorkerResult } from './lead-worker';
import { purgeExpiredSessions } from '@/lib/auth/session';

export type TickResult = {
  workerId: string;
  sends: { claimed: number; sent: number; deferred: number; failed: number; cancelled: number };
  sequences: { due: number; queued: number; completed: number; paused: number; deferred: number };
  ai: { due: number; replied: number; handoff: number; failed: number; skipped: number };
  leads: LeadWorkerResult;
  reminders: number;
  durationMs: number;
};

export type TickOptions = {
  sendBatch?: number;
  sequenceBatch?: number;
  aiBatch?: number;
  leadBatch?: number;
  /** Skip housekeeping when ticking frequently. */
  skipMaintenance?: boolean;
};

/**
 * One pass of all background work.
 *
 * Runs from the long-lived worker process and from `POST /api/worker/tick`, so
 * a serverless deployment can drive it from a scheduler instead. It is safe to
 * run concurrently: every unit of work is claimed with a lock or an idempotency
 * key before anything is sent.
 */
export async function tick(options: TickOptions = {}): Promise<TickResult> {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const log = logger.child({ jobId: workerId });

  const result: TickResult = {
    workerId,
    sends: { claimed: 0, sent: 0, deferred: 0, failed: 0, cancelled: 0 },
    sequences: { due: 0, queued: 0, completed: 0, paused: 0, deferred: 0 },
    ai: { due: 0, replied: 0, handoff: 0, failed: 0, skipped: 0 },
    leads: { claimed: 0, succeeded: 0, skipped: 0, retrying: 0, dead: 0 },
    reminders: 0,
    durationMs: 0,
  };

  // 1. Sequences first: they create the work the sender then drains.
  try {
    const memberships = await dueMemberships(options.sequenceBatch ?? 50);
    result.sequences.due = memberships.length;
    for (const membership of memberships) {
      try {
        const outcome = await processMembership(membership);
        if (outcome.result === 'queued') result.sequences.queued += 1;
        else if (outcome.result === 'completed' || outcome.result === 'stopped') result.sequences.completed += 1;
        else if (outcome.result === 'paused') result.sequences.paused += 1;
        else result.sequences.deferred += 1;
      } catch (error) {
        log.error('sequence step failed', { errorCode: errorMessage(error).slice(0, 120) });
      }
    }
  } catch (error) {
    log.error('sequence pass failed', { errorCode: errorMessage(error).slice(0, 120) });
  }

  // 2. AI turns for conversations that are due a response.
  try {
    const due = await dueFollowUps(options.aiBatch ?? 25);
    result.ai.due = due.length;
    for (const conversation of due) {
      // Clear the marker first: a crash mid-turn must not put the worker into a
      // loop retrying the same conversation forever.
      await getDb()
        .update(conversations)
        .set({ nextFollowUpAt: null })
        .where(eq(conversations.id, conversation.id));

      try {
        const ctx = await ctxForOrg(conversation.organizationId);
        const outcome = await runSalesTurn(ctx, conversation.id);
        if (outcome.result === 'replied') result.ai.replied += 1;
        else if (outcome.result === 'handoff') result.ai.handoff += 1;
        else if (outcome.result === 'failed') result.ai.failed += 1;
        else result.ai.skipped += 1;
      } catch (error) {
        result.ai.failed += 1;
        log.error('ai turn threw', { errorCode: errorMessage(error).slice(0, 120) });
      }
    }
  } catch (error) {
    log.error('ai pass failed', { errorCode: errorMessage(error).slice(0, 120) });
  }

  // 3. Drain the outbound queue.
  try {
    const jobs = await claimJobs(options.sendBatch ?? 25, workerId);
    result.sends.claimed = jobs.length;
    for (const job of jobs) {
      try {
        const outcome = await processOutboundJob(job);
        if (outcome.result === 'sent') result.sends.sent += 1;
        else if (outcome.result === 'deferred') result.sends.deferred += 1;
        else if (outcome.result === 'cancelled') result.sends.cancelled += 1;
        else result.sends.failed += 1;
      } catch (error) {
        result.sends.failed += 1;
        log.error('send job threw', { errorCode: errorMessage(error).slice(0, 120) });
      }
    }
  } catch (error) {
    log.error('send pass failed', { errorCode: errorMessage(error).slice(0, 120) });
  }

  // 4. The lead pipeline: discovery, enrichment, research, scoring.
  try {
    result.leads = await runLeadJobs(options.leadBatch ?? 10, workerId);
  } catch (error) {
    log.error('lead pass failed', { errorCode: errorMessage(error).slice(0, 120) });
  }

  // 5. Appointment reminders.
  try {
    result.reminders = await sendDueAppointmentReminders();
  } catch (error) {
    log.error('reminder pass failed', { errorCode: errorMessage(error).slice(0, 120) });
  }

  if (!options.skipMaintenance) {
    try {
      await purgeExpiredSessions();
    } catch {
      // Housekeeping only.
    }
  }

  result.durationMs = Date.now() - started;
  if (hasWork(result)) log.info('worker tick', { ...flatten(result) });
  return result;
}

async function ctxForOrg(organizationId: string) {
  const rows = await getDb()
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return systemCtx(organizationId, rows[0]?.timezone ?? 'America/Toronto');
}

function hasWork(result: TickResult): boolean {
  return (
    result.sends.claimed > 0 ||
    result.sequences.due > 0 ||
    result.ai.due > 0 ||
    result.leads.claimed > 0 ||
    result.reminders > 0
  );
}

function flatten(result: TickResult): Record<string, unknown> {
  return {
    sent: result.sends.sent,
    deferred: result.sends.deferred,
    sendFailed: result.sends.failed,
    sequencesQueued: result.sequences.queued,
    aiReplied: result.ai.replied,
    aiHandoff: result.ai.handoff,
    leadsProcessed: result.leads.succeeded,
    leadsDead: result.leads.dead,
    reminders: result.reminders,
    latencyMs: result.durationMs,
  };
}
