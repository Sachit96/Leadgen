import { getDb } from '@/lib/db';
import { leadDiscoveryRecords } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/core/logger';
import { errorMessage } from '@/lib/core/errors';
import { systemCtx } from '@/lib/auth/context';
import { researchBusiness } from '@/lib/agents/business-research';
import { generateLeadPersonalization } from '@/lib/agents/lead-personalization';
import {
  claimLeadJobs,
  completeLeadJob,
  enqueueLeadJob,
  failLeadJob,
  skipLeadJob,
  type ClaimedLeadJob,
} from '@/lib/services/lead-jobs';
import {
  finalizeSearchIfDone,
  runDiscovery,
  runNormalization,
  runScoring,
  runWebsiteEnrichment,
  type StageResult,
} from '@/lib/services/lead-pipeline';
import { bumpSearchCounter } from '@/lib/services/lead-search';
import { buildQueueFromFilters } from '@/lib/services/call-queue';
import { enrichContact } from '@/lib/services/contact-enrichment';

export type LeadWorkerResult = {
  claimed: number;
  succeeded: number;
  skipped: number;
  retrying: number;
  dead: number;
};

/**
 * Drains the lead pipeline queue.
 *
 * Every stage returns a `StageResult` rather than throwing, so one lead with a
 * broken website can never take down the batch — the failure is recorded
 * against that record and the rest carry on.
 */
export async function runLeadJobs(limit: number, workerId: string): Promise<LeadWorkerResult> {
  const result: LeadWorkerResult = { claimed: 0, succeeded: 0, skipped: 0, retrying: 0, dead: 0 };

  const jobs = await claimLeadJobs(limit, workerId);
  result.claimed = jobs.length;

  for (const job of jobs) {
    const log = logger.child({ jobId: job.id, organizationId: job.organizationId });

    try {
      const outcome = await runStage(job);

      if (outcome.result === 'ok') {
        await completeLeadJob(job.id);
        result.succeeded += 1;
      } else if (outcome.result === 'skipped') {
        await skipLeadJob(job.id, outcome.reason);
        result.skipped += 1;
      } else {
        const disposition = await failLeadJob(job, outcome.error, {
          retryable: outcome.retryable,
          code: outcome.code,
        });
        if (disposition === 'dead') {
          result.dead += 1;
          await markRecordFailed(job, outcome.error, outcome.code);
          if (job.searchJobId) await bumpSearchCounter(job.searchJobId, 'failedCount');
        } else {
          result.retrying += 1;
        }
        log.warn('lead job failed', { result: disposition, errorCode: outcome.code ?? 'UNKNOWN' });
      }
    } catch (error) {
      // A stage that threw rather than returning is a bug, but it must still
      // not stop the batch.
      const disposition = await failLeadJob(job, errorMessage(error), { retryable: true });
      if (disposition === 'dead') result.dead += 1;
      else result.retrying += 1;
      log.error('lead job threw', { errorCode: errorMessage(error).slice(0, 120) });
    }

    await finalizeSearchIfDone(job);
  }

  return result;
}

async function runStage(job: ClaimedLeadJob): Promise<StageResult> {
  switch (job.type) {
    case 'lead_discovery':
      return runDiscovery(job);

    case 'lead_normalization':
    case 'lead_deduplication':
      return runNormalization(job);

    case 'website_enrichment':
    case 'social_enrichment':
      return runWebsiteEnrichment(job);

    case 'ai_research':
      return runResearch(job);

    case 'lead_scoring':
      return runScoring(job);

    case 'personalization_generation':
      return runPersonalization(job);

    case 'contact_enrichment':
      return runContactEnrichment(job);

    case 'call_queue_generation':
      return runQueueGeneration(job);

    case 'campaign_assignment':
      return { result: 'skipped', reason: 'campaign assignment is an operator action' };

    default:
      return { result: 'skipped', reason: `no handler for ${job.type}` };
  }
}

/**
 * Promotes what the crawl found onto the prospect: a public email address, a
 * corroborated phone number, an owner's name. It only ever adds — anything a
 * human entered stays as they entered it.
 */
async function runContactEnrichment(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.contactId) return { result: 'skipped', reason: 'no contact to enrich' };
  const ctx = systemCtx(job.organizationId);

  const outcome = await enrichContact(ctx, job.contactId);

  // Research runs either way: finding nothing new on the contact page is not a
  // reason to stop the lead, and a skipped stage must still hand off or the
  // pipeline stalls here.
  if (job.companyId) {
    await enqueueLeadJob(ctx, {
      type: 'ai_research',
      idempotencyKey: `research:${job.companyId}`,
      searchJobId: job.searchJobId,
      discoveryRecordId: job.discoveryRecordId,
      companyId: job.companyId,
      contactId: job.contactId,
      priority: 5,
    });
  }

  if (outcome.result === 'skipped') return { result: 'skipped', reason: outcome.reason };
  return { result: 'ok', detail: `added ${outcome.added.join(', ')}` };
}

async function runResearch(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.companyId) return { result: 'skipped', reason: 'no company' };
  const ctx = systemCtx(job.organizationId);

  const outcome = await researchBusiness(ctx, job.companyId, { contactId: job.contactId });

  if (outcome.result === 'failed') {
    return { result: 'failed', error: outcome.error, retryable: outcome.retryable, code: 'AI_ERROR' };
  }

  await getDb()
    .update(leadDiscoveryRecords)
    .set({ stage: 'RESEARCHED' })
    .where(eq(leadDiscoveryRecords.companyId, job.companyId));

  if (job.searchJobId && outcome.result === 'researched') {
    await bumpSearchCounter(job.searchJobId, 'researchedCount');
  }

  // Scoring needs a contact to attach to; without one the lead is a company
  // record only and there is nothing to call.
  if (job.contactId) {
    await enqueueLeadJob(ctx, {
      type: 'lead_scoring',
      idempotencyKey: `score:${job.contactId}`,
      searchJobId: job.searchJobId,
      discoveryRecordId: job.discoveryRecordId,
      companyId: job.companyId,
      contactId: job.contactId,
      priority: 5,
    });
  }

  return { result: 'ok', detail: outcome.result };
}

async function runPersonalization(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.contactId) return { result: 'skipped', reason: 'no contact' };
  const ctx = systemCtx(job.organizationId);

  const outcome = await generateLeadPersonalization(ctx, job.contactId);

  if (outcome.result === 'failed') {
    return { result: 'failed', error: outcome.error, retryable: outcome.retryable, code: 'AI_ERROR' };
  }
  if (outcome.result === 'skipped') return { result: 'skipped', reason: outcome.reason };

  await getDb()
    .update(leadDiscoveryRecords)
    .set({ stage: 'REVIEW' })
    .where(eq(leadDiscoveryRecords.contactId, job.contactId));

  return { result: 'ok', detail: outcome.output.recommended_angle };
}

async function runQueueGeneration(job: ClaimedLeadJob): Promise<StageResult> {
  const ctx = systemCtx(job.organizationId);
  const payload = job.payload as { queueId?: string };
  if (!payload.queueId) return { result: 'skipped', reason: 'no queue id' };

  const added = await buildQueueFromFilters(ctx, payload.queueId);
  return { result: 'ok', detail: `${added} leads queued` };
}

async function markRecordFailed(job: ClaimedLeadJob, error: string, code?: string): Promise<void> {
  if (!job.discoveryRecordId) return;
  await getDb()
    .update(leadDiscoveryRecords)
    .set({
      stage: 'FAILED',
      errorCode: code ?? 'STAGE_FAILED',
      errorMessage: error.slice(0, 500),
      attemptCount: job.attempts,
    })
    .where(eq(leadDiscoveryRecords.id, job.discoveryRecordId));
}
