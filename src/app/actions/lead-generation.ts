'use server';

import { requireCtx } from '@/lib/auth/context';
import {
  cancelSearchJob,
  createSearchJob,
  deleteSavedSearch,
  saveSearch,
  startSearchJob,
} from '@/lib/services/lead-search';
import { approveLeads, rejectLeads, requeueStage } from '@/lib/services/leads';
import { researchBusiness } from '@/lib/agents/business-research';
import { generateLeadPersonalization } from '@/lib/agents/lead-personalization';
import { action, bool, list, num, optionalNum, optionalStr, str } from './helpers';

const LEAD_PATHS = ['/lead-generation', '/lead-generation/leads', '/prospects'];

/** Filters shared by the search form and the saved-search form. */
function searchFilters(form: FormData) {
  return {
    minReviews: optionalNum(form, 'minReviews') ?? undefined,
    maxReviews: optionalNum(form, 'maxReviews') ?? undefined,
    minRating: optionalNum(form, 'minRating') ?? undefined,
    minScore: optionalNum(form, 'minScore') ?? undefined,
    requirePhone: bool(form, 'requirePhone'),
    requireWebsite: bool(form, 'requireWebsite'),
    excludeChains: bool(form, 'excludeChains'),
  };
}

/**
 * The market definition, as one query string.
 *
 * Keywords are appended rather than sent as a separate field because that is
 * what a text-search provider actually accepts — Places has no keyword
 * parameter, it has a query.
 */
function marketQuery(form: FormData): string {
  const industry = str(form, 'query');
  const keywords = str(form, 'keywords');
  return keywords ? `${industry} ${keywords}` : industry;
}

export async function startLeadSearchAction(form: FormData) {
  return action(
    'leadgen.search',
    async () => {
      const ctx = await requireCtx('prospect:import');
      const job = await createSearchJob(ctx, {
        query: marketQuery(form),
        location: str(form, 'location'),
        radiusMeters: num(form, 'radiusMeters', 25_000),
        requestedCount: num(form, 'requestedCount', 100),
        filters: searchFilters(form),
      });
      // Created as a draft and started separately, so a validation failure
      // never leaves a half-started search on the board.
      await startSearchJob(ctx, job.id);
      return { id: job.id };
    },
    LEAD_PATHS,
  );
}

export async function cancelLeadSearchAction(searchJobId: string) {
  return action(
    'leadgen.cancel',
    async () => {
      const ctx = await requireCtx('prospect:import');
      await cancelSearchJob(ctx, searchJobId);
      return { id: searchJobId };
    },
    LEAD_PATHS,
  );
}

export async function saveSearchAction(form: FormData) {
  return action(
    'leadgen.saveSearch',
    async () => {
      const ctx = await requireCtx('prospect:import');
      const saved = await saveSearch(ctx, {
        name: str(form, 'name'),
        query: marketQuery(form),
        location: str(form, 'location'),
        radiusMeters: num(form, 'radiusMeters', 25_000),
        filters: searchFilters(form),
      });
      return { id: saved.id };
    },
    LEAD_PATHS,
  );
}

export async function deleteSavedSearchAction(id: string) {
  return action(
    'leadgen.deleteSavedSearch',
    async () => {
      const ctx = await requireCtx('prospect:import');
      await deleteSavedSearch(ctx, id);
      return { id };
    },
    LEAD_PATHS,
  );
}

export async function approveLeadsAction(form: FormData) {
  return action(
    'leadgen.approve',
    async () => {
      const ctx = await requireCtx('prospect:write');
      const count = await approveLeads(ctx, list(form, 'contactId'));
      return { count };
    },
    LEAD_PATHS,
  );
}

export async function rejectLeadsAction(form: FormData) {
  return action(
    'leadgen.reject',
    async () => {
      const ctx = await requireCtx('prospect:write');
      const count = await rejectLeads(ctx, list(form, 'contactId'), optionalStr(form, 'reason') ?? undefined);
      return { count };
    },
    LEAD_PATHS,
  );
}

/** Puts one lead back through a stage — the fix for a bad crawl or a stale score. */
export type RequeueStage = 'website_enrichment' | 'ai_research' | 'lead_scoring' | 'personalization_generation';

export async function requeueLeadAction(contactId: string, stage: RequeueStage) {
  return action(
    'leadgen.requeue',
    async () => {
      const ctx = await requireCtx('prospect:write');
      await requeueStage(ctx, contactId, stage);
      return { contactId, stage };
    },
    LEAD_PATHS,
  );
}

/**
 * Re-runs research and the opening line for one lead, in the request rather
 * than the queue, so the reviewer sees the new copy immediately.
 */
export async function regenerateLeadCopyAction(contactId: string, companyId: string) {
  return action(
    'leadgen.regenerate',
    async () => {
      const ctx = await requireCtx('prospect:write');
      const research = await researchBusiness(ctx, companyId, { force: true, contactId });
      if (research.result === 'failed') throw new Error(research.error);
      const personalization = await generateLeadPersonalization(ctx, contactId, { force: true });
      if (personalization.result === 'failed') throw new Error(personalization.error);
      return { result: personalization.result };
    },
    LEAD_PATHS,
  );
}
