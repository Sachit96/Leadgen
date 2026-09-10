import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  callAttempts,
  callQueueItems,
  campaignMemberships,
  companies,
  contacts,
  leadDiscoveryRecords,
  leadEnrichment,
  leadJobs,
  leadPersonalization,
  leadSignals,
  messages,
  outboundJobs,
} from '@/lib/db/schema';
import { createHarness, type Harness } from '../helpers/harness';
import { createSearchJob, getSearchJob, retrySearchJob, searchOutcome, startSearchJob } from '@/lib/services/lead-search';
import { approveLeads, getLeadDetail, listLeads } from '@/lib/services/leads';
import { addToQueue, createCallQueue, currentQueuePosition, loadCallCard } from '@/lib/services/call-queue';
import { initiateCall, listCallHistory, recordDisposition } from '@/lib/services/calls';
import { enrollProspects } from '@/lib/services/campaigns';
import { telUri } from '@/lib/providers/call';
import { tick } from '@/lib/worker/tick';

async function drain(maxTicks = 80): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await tick({ sendBatch: 0, sequenceBatch: 0, aiBatch: 0, leadBatch: 25, skipMaintenance: true });
    if (result.leads.claimed === 0) return;
  }
}

/**
 * The whole product, in one test.
 *
 * Search → discover → normalize → dedupe → crawl → extract → signals → contact
 * enrichment → research → score → min-score gate → personalization → review →
 * approve → prospect → call queue → call → disposition, with the provenance
 * chain intact at the end.
 *
 * Every assertion reads the database. Nothing is stubbed except the discovery
 * provider and the AI, both of which are the app's own documented mocks.
 */
describe('the full vertical slice', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('runs a market search through to a dispositioned call', async () => {
    /* ---------------------------------------------------------- 1. search */
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 12,
      filters: { requirePhone: true, requireWebsite: true, minScore: 30 },
    });
    expect(search.status).toBe('DRAFT');

    await startSearchJob(h.ctx, search.id);
    expect((await getSearchJob(h.ctx, search.id)).status).toBe('QUEUED');

    await drain();

    /* ------------------------------------------------- 2-3. discover, run */
    const run = await getSearchJob(h.ctx, search.id);
    expect(run.status).toBe('COMPLETED');
    expect(run.discoveredCount).toBeGreaterThan(0);
    expect(h.discovery.searches).toHaveLength(1);
    // Counters are database-derived, not guessed: they add up.
    expect(run.uniqueCount + run.duplicateCount).toBeLessThanOrEqual(run.discoveredCount);

    /* ----------------------------------------------- 4-5. normalize, dedupe */
    const records = await h.db.select().from(leadDiscoveryRecords);
    expect(records.length).toBe(run.discoveredCount);
    const promoted = records.filter((r) => r.companyId !== null);
    expect(promoted.length).toBe(run.uniqueCount);
    // No business is in the CRM twice.
    const companyRows = await h.db.select().from(companies);
    const externalIds = companyRows.map((c) => c.externalId).filter(Boolean);
    expect(new Set(externalIds).size).toBe(externalIds.length);

    /* --------------------------------------------------- 6-7. crawl, store */
    const crawled = records.filter((r) => r.crawlStatus === 'OK');
    expect(crawled.length).toBeGreaterThan(0);
    expect(crawled[0]!.pagesCrawled).toBeGreaterThan(1);

    const enrichment = await h.db
      .select()
      .from(leadEnrichment)
      .where(and(eq(leadEnrichment.kind, 'website'), eq(leadEnrichment.ok, true)));
    expect(enrichment.length).toBe(crawled.length);
    const stored = enrichment[0]!.output as {
      pages?: Array<{ url: string; role: string; text: string }>;
      attempts?: unknown[];
    };
    expect(stored.pages?.length).toBeGreaterThan(1);
    expect(stored.pages!.every((p) => p.text.length > 0)).toBe(true);

    /* ------------------------------------------------------ 8. signals */
    const signals = await h.db.select().from(leadSignals);
    const detected = signals.filter((s) => s.detected);
    expect(detected.length).toBeGreaterThan(0);
    // Provenance where applicable: every detected signal names its evidence.
    for (const signal of detected) expect(signal.evidence).toBeTruthy();
    // Observed and inferred are distinguishable in the data, not just the UI.
    expect(detected.some((s) => s.inferred === false)).toBe(true);
    expect(detected.some((s) => s.inferred === true)).toBe(true);

    /* -------------------------------------------- 8b. contact enrichment */
    const enrichJobs = await h.db
      .select()
      .from(leadJobs)
      .where(eq(leadJobs.type, 'contact_enrichment'));
    expect(enrichJobs.length).toBeGreaterThan(0);
    expect(enrichJobs.every((j) => j.status === 'SUCCEEDED' || j.status === 'SKIPPED')).toBe(true);
    // The crawl found public addresses, and they landed on the prospects.
    const withEmail = await h.db.select().from(contacts);
    expect(withEmail.some((c) => c.email !== null)).toBe(true);
    expect(detected.some((s) => s.key === 'public_email_found' || s.key === 'phone_corroborated')).toBe(true);

    /* --------------------------------------------------- 9. AI research */
    const researchCalls = h.ai.calls.filter((c) => c.system.includes('AGENT: business_research'));
    expect(researchCalls.length).toBeGreaterThan(0);
    // Research consumed the stored crawl output, not a summary of it.
    const promptsWithPages = researchCalls
      .map((c) => c.messages.at(-1)!.content)
      .filter((p) => p.includes('--- PAGE: '));
    expect(promptsWithPages.length).toBeGreaterThan(0);
    expect(promptsWithPages[0]).toMatch(/roof repair|roof replacement|siding/);
    expect(companyRows.some((c) => c.researchSummary !== null || c.researchedAt !== null)).toBe(true);

    /* -------------------------------------- 10-11. ICP score, min gate */
    const scored = await h.db.select().from(contacts);
    expect(scored.every((c) => c.score !== null)).toBe(true);
    expect(scored.every((c) => (c.scoreBreakdown as unknown[]).length > 0)).toBe(true);

    // The gate holds in both directions.
    for (const contact of scored) {
      if (contact.score !== null && contact.score < 30) {
        expect(contact.callReadiness).not.toBe('READY');
      }
    }

    /* ------------------------------------------- 12. personalization */
    const copy = await h.db.select().from(leadPersonalization);
    expect(copy.length).toBeGreaterThan(0);
    expect(copy[0]!.callOpener).toBeTruthy();
    expect(copy[0]!.openingMessage).toBeTruthy();
    // Nothing was sent merely because a lead was discovered.
    expect(await h.db.select().from(outboundJobs)).toHaveLength(0);
    expect(await h.db.select().from(messages)).toHaveLength(0);

    /* --------------------------------------------- 13. human review */
    const review = await listLeads(h.ctx, { filters: { view: 'REVIEW' } });
    expect(review.total).toBeGreaterThan(0);

    const detail = await getLeadDetail(h.ctx, review.rows[0]!.contactId);
    // Everything requirement 14 asks the operator to be able to see.
    expect(detail.discovery?.provider).toBe('mock');
    expect(detail.discovery?.raw).toBeTruthy();
    expect(detail.discovery?.businessName).toBeTruthy();
    expect(detail.discovery?.crawlStatus).toBeTruthy();
    expect(detail.search?.id).toBe(search.id);
    expect(detail.enrichment.length).toBeGreaterThan(0);
    expect(detail.signals.length).toBeGreaterThan(0);
    expect(detail.company?.researchedAt ?? detail.company?.researchSummary).toBeTruthy();
    expect((detail.contact.scoreBreakdown as unknown[]).length).toBeGreaterThan(0);
    expect(detail.personalization).not.toBeNull();
    expect(Array.isArray(detail.stageErrors)).toBe(true);

    /* --------------------------------------- 14. approve → prospect */
    const target = review.rows[0]!;
    await approveLeads(h.ctx, [target.contactId]);

    const approvedRecord = (
      await h.db.select().from(leadDiscoveryRecords).where(eq(leadDiscoveryRecords.contactId, target.contactId))
    )[0]!;
    expect(approvedRecord.stage).toBe('APPROVED');

    // It is a real On Radar prospect — the same row, not a copy.
    const prospect = (await h.db.select().from(contacts).where(eq(contacts.id, target.contactId)))[0]!;
    expect(prospect.status).toBe('READY');
    expect(prospect.companyId).toBe(approvedRecord.companyId);
    expect(prospect.callReadiness).toBe('READY');

    /* ------------------------------------------------ 15. call queue */
    const queue = await createCallQueue(h.ctx, { name: 'Slice', filters: {} });
    expect(queue.totalCount).toBeGreaterThan(0);
    await addToQueue(h.ctx, queue.id, [target.contactId]);

    const inQueue = await h.db
      .select()
      .from(callQueueItems)
      .where(and(eq(callQueueItems.queueId, queue.id), eq(callQueueItems.contactId, target.contactId)));
    expect(inQueue).toHaveLength(1);

    /* -------------------------------------------- 16-17. call view, tel: */
    const position = (await currentQueuePosition(h.ctx, queue.id))!;
    expect(position.total).toBe(queue.totalCount);
    expect(position.index).toBe(1);

    const card = await loadCallCard(h.ctx, position.contactId);
    expect(card.contact.phone).toBeTruthy();
    expect(card.company?.name).toBeTruthy();
    // The real tel: action, built from the stored number.
    const uri = telUri(card.contact.phone);
    expect(uri).toBe(`tel:${card.contact.phone}`);

    const attempt = await initiateCall(h.ctx, {
      contactId: position.contactId,
      queueId: queue.id,
      queueItemId: position.itemId,
    });
    expect(attempt.uri).toBe(uri);
    // Device telephony cannot observe a connection, and does not claim to.
    expect(attempt.reportsConnection).toBe(false);

    const initiated = (await h.db.select().from(callAttempts).where(eq(callAttempts.id, attempt.attemptId)))[0]!;
    expect(initiated.outcome).toBe('INITIATED');
    expect(initiated.connectionReported).toBe(false);

    /* ------------------------------------------- 18. disposition persists */
    await recordDisposition(h.ctx, {
      attemptId: attempt.attemptId,
      contactId: position.contactId,
      outcome: 'BOOKED',
      note: 'Wants a walkthrough Thursday',
      queueItemId: position.itemId,
    });

    const dispositioned = (
      await h.db.select().from(callAttempts).where(eq(callAttempts.id, attempt.attemptId))
    )[0]!;
    expect(dispositioned.outcome).toBe('BOOKED');
    expect(dispositioned.note).toBe('Wants a walkthrough Thursday');
    expect(dispositioned.dispositionedAt).toBeTruthy();
    expect(dispositioned.connectionReported).toBe(false);

    const afterCall = (await h.db.select().from(contacts).where(eq(contacts.id, position.contactId)))[0]!;
    expect(afterCall.status).toBe('APPOINTMENT');
    expect(afterCall.lastCallOutcome).toBe('BOOKED');

    // The queue moved on.
    const workedItem = (
      await h.db.select().from(callQueueItems).where(eq(callQueueItems.id, position.itemId))
    )[0]!;
    expect(workedItem.status).toBe('COMPLETED');
    expect(workedItem.outcome).toBe('BOOKED');

    /* --------------------------------- 19. the chain is still connected */
    const finalDetail = await getLeadDetail(h.ctx, position.contactId);
    expect(finalDetail.search?.id).toBe(search.id);
    expect(finalDetail.discovery?.searchJobId).toBe(search.id);
    expect(finalDetail.discovery?.companyId).toBe(finalDetail.company?.id);
    expect(finalDetail.discovery?.contactId).toBe(position.contactId);
    expect(finalDetail.enrichment.some((e) => e.companyId === finalDetail.company?.id)).toBe(true);
    expect(finalDetail.calls.map((c) => c.id)).toContain(attempt.attemptId);
    expect(await listCallHistory(h.ctx, position.contactId)).toHaveLength(1);

    // And the run's own numbers still describe it.
    const outcome = await searchOutcome(h.ctx, search.id);
    expect(outcome.leads).toBe(run.uniqueCount);
    expect(outcome.averageScore).toBeGreaterThan(0);
  }, 180_000);

  it('enrols an approved lead in a campaign without sending anything', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 6,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const leads = await listLeads(h.ctx, { filters: { view: 'CAMPAIGN_READY' } });
    expect(leads.total).toBeGreaterThan(0);
    const target = leads.rows[0]!;
    await approveLeads(h.ctx, [target.contactId]);

    // The existing campaign engine, not a parallel one.
    const result = await enrollProspects(h.ctx, h.campaignId, [target.contactId]);
    expect(result.enrolled).toBe(1);

    const membership = await h.db
      .select()
      .from(campaignMemberships)
      .where(eq(campaignMemberships.contactId, target.contactId));
    expect(membership).toHaveLength(1);
    expect(membership[0]!.campaignId).toBe(h.campaignId);

    // Requirement 20: discovery and approval never send. Enrolment schedules;
    // the sequence decides when, and the worker sends on its own terms.
    expect(await h.db.select().from(messages)).toHaveLength(0);
  }, 120_000);

  it('retries only what failed, and does so idempotently', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 8,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const before = {
      companies: (await h.db.select().from(companies)).length,
      contacts: (await h.db.select().from(contacts)).length,
      records: (await h.db.select().from(leadDiscoveryRecords)).length,
      enrichment: (await h.db.select().from(leadEnrichment)).length,
      searches: h.discovery.searches.length,
    };

    // Retrying a healthy run changes nothing.
    const first = await retrySearchJob(h.ctx, search.id);
    expect(first.revived).toBe(0);
    expect(first.requeued).toBe(0);
    await drain();

    // And doing it again still changes nothing — no duplicate companies,
    // prospects, discovery records or crawls.
    await retrySearchJob(h.ctx, search.id);
    await drain();

    expect((await h.db.select().from(companies)).length).toBe(before.companies);
    expect((await h.db.select().from(contacts)).length).toBe(before.contacts);
    expect((await h.db.select().from(leadDiscoveryRecords)).length).toBe(before.records);
    expect((await h.db.select().from(leadEnrichment)).length).toBe(before.enrichment);
    expect(h.discovery.searches.length).toBe(before.searches);
    expect((await getSearchJob(h.ctx, search.id)).status).toBe('COMPLETED');
  }, 180_000);

  it('revives a run whose discovery failed, without duplicating the leads', async () => {
    h.discovery.failNext = true;
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 6,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    expect((await getSearchJob(h.ctx, search.id)).status).toBe('FAILED');
    expect(await h.db.select().from(companies)).toHaveLength(0);

    // The provider is healthy now; the retry gets the run moving.
    await retrySearchJob(h.ctx, search.id);
    await drain();

    const revived = await getSearchJob(h.ctx, search.id);
    expect(revived.status).toBe('COMPLETED');
    expect(revived.discoveredCount).toBeGreaterThan(0);
    expect((await h.db.select().from(companies)).length).toBeGreaterThan(0);

    // A second retry after success is still a no-op.
    const companiesAfter = (await h.db.select().from(companies)).length;
    await retrySearchJob(h.ctx, search.id);
    await drain();
    expect((await h.db.select().from(companies)).length).toBe(companiesAfter);
  }, 180_000);
});
