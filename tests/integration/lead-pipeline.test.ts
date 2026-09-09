import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  callQueueItems,
  companies,
  contacts,
  duplicateMatches,
  leadDiscoveryRecords,
  leadJobs,
  leadPersonalization,
} from '@/lib/db/schema';
import { createHarness, type Harness } from '../helpers/harness';
import { createSearchJob, getSearchJob, startSearchJob, searchProgress } from '@/lib/services/lead-search';
import { listLeads, leadViewCounts, approveLeads, rejectLeads, getLeadDetail } from '@/lib/services/leads';
import {
  createCallQueue,
  currentQueuePosition,
  listCallQueues,
  loadCallCard,
  skipQueueItem,
} from '@/lib/services/call-queue';
import { initiateCall, recordDisposition, callMetrics, listCallHistory } from '@/lib/services/calls';
import { tick } from '@/lib/worker/tick';
import { telUri } from '@/lib/providers/call';
import { daysAgo } from '@/lib/core/time';

/** Runs the pipeline to completion, with a bound so a bug cannot hang the suite. */
async function drain(maxTicks = 40): Promise<number> {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await tick({ sendBatch: 0, sequenceBatch: 0, aiBatch: 0, leadBatch: 25, skipMaintenance: true });
    if (result.leads.claimed === 0) return i;
  }
  return maxTicks;
}

describe('lead generation pipeline', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('runs search through to a call-ready, personalized lead', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 12,
      filters: { requirePhone: true, requireWebsite: true, minReviews: 10 },
    });
    expect(search.status).toBe('DRAFT');

    await startSearchJob(h.ctx, search.id);
    expect((await getSearchJob(h.ctx, search.id)).status).toBe('QUEUED');

    await drain();

    // --- discovery ---------------------------------------------------------
    const finished = await getSearchJob(h.ctx, search.id);
    expect(finished.discoveredCount).toBeGreaterThan(0);
    expect(finished.uniqueCount).toBeGreaterThan(0);
    expect(finished.status).toBe('COMPLETED');
    expect(h.discovery.searches).toHaveLength(1);
    expect(h.discovery.searches[0]!.query).toBe('roofing');

    // --- promotion into the existing CRM ------------------------------------
    const promotedCompanies = await h.db.select().from(companies);
    const promotedContacts = await h.db.select().from(contacts);
    expect(promotedCompanies.length).toBe(finished.uniqueCount);
    expect(promotedContacts.length).toBe(finished.uniqueCount);

    const company = promotedCompanies[0]!;
    expect(company.externalId).toMatch(/^mock_/);
    expect(company.discoverySource).toBe('mock');
    // Provenance is preserved, not discarded on promotion.
    expect(company.sourceUrl).toBeTruthy();
    expect(company.nameKey).toBe(company.nameKey?.toLowerCase());

    // --- enrichment, research, scoring, personalization ---------------------
    const enriched = promotedCompanies.filter((c) => c.enrichedAt !== null);
    // The mock's .example domains do not resolve, which is the realistic case
    // for a dead site: recorded as a finding, and the lead still progresses.
    expect(enriched.length + promotedCompanies.filter((c) => c.websiteQuality === 'none').length)
      .toBe(promotedCompanies.length);

    const researched = promotedCompanies.filter((c) => c.researchSummary !== null);
    expect(researched.length).toBeGreaterThan(0);

    const scored = promotedContacts.filter((c) => c.score !== null);
    expect(scored.length).toBe(promotedContacts.length);
    for (const contact of scored) {
      expect(contact.scoreBucket).toMatch(/^[ABCD]$/);
      expect(Array.isArray(contact.scoreBreakdown)).toBe(true);
    }

    const personalizations = await h.db.select().from(leadPersonalization);
    expect(personalizations.length).toBeGreaterThan(0);
    expect(personalizations[0]!.callOpener).toBeTruthy();
    expect(personalizations[0]!.openingMessage).toBeTruthy();

    // --- progress is counted, not estimated ---------------------------------
    const progress = await searchProgress(h.ctx, search.id);
    expect(Object.values(progress).reduce((a, b) => a + b, 0)).toBe(finished.discoveredCount);

    // --- the lead inbox reads the CRM ---------------------------------------
    const leads = await listLeads(h.ctx, { filters: { view: 'ALL' } });
    expect(leads.total).toBe(promotedContacts.length);
    expect(leads.rows[0]!.hasPersonalization).toBe(true);

    const counts = await leadViewCounts(h.ctx);
    expect(counts.ALL).toBe(promotedContacts.length);
    expect(counts.CALL_READY).toBeGreaterThan(0);

    // Highest score first, so the best leads are worked first.
    const scores = leads.rows.map((r) => r.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('deduplicates a repeated search instead of creating the leads twice', async () => {
    const first = await createSearchJob(h.ctx, {
      query: 'roofing', location: 'Brampton, ON', requestedCount: 8, filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, first.id);
    await drain();

    const afterFirst = await h.db.select().from(companies);
    expect(afterFirst.length).toBeGreaterThan(0);

    // The identical search again: the provider is deterministic, so every
    // business comes back and every one must be recognised.
    const second = await createSearchJob(h.ctx, {
      query: 'roofing', location: 'Brampton, ON', requestedCount: 8, filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, second.id);
    await drain();

    const afterSecond = await h.db.select().from(companies);
    expect(afterSecond.length).toBe(afterFirst.length);

    const secondJob = await getSearchJob(h.ctx, second.id);
    // Nothing new was discovered, because the unique index caught the re-insert.
    expect(secondJob.uniqueCount).toBe(0);
  });

  it('records a duplicate with its reason rather than deleting it', async () => {
    // A company that already exists, with a phone number a search will find.
    const [existing] = await h.db
      .insert(companies)
      .values({ organizationId: h.ctx.organizationId, name: 'Pre-existing Roofing', nameKey: 'pre existing roofing' })
      .returning();
    await h.db.insert(contacts).values({
      organizationId: h.ctx.organizationId,
      companyId: existing!.id,
      phone: '+14165550142',
      status: 'NEW',
    });

    const search = await createSearchJob(h.ctx, {
      query: 'roofing', location: 'Mississauga, ON', requestedCount: 30, filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const dupes = await h.db
      .select()
      .from(leadDiscoveryRecords)
      .where(eq(leadDiscoveryRecords.stage, 'DUPLICATE'));

    if (dupes.length > 0) {
      // Nothing is deleted: the record survives with its reason attached.
      expect(dupes[0]!.duplicateReason).toBeTruthy();
      expect(dupes[0]!.duplicateOfCompanyId).toBeTruthy();
      const matches = await h.db.select().from(duplicateMatches);
      expect(matches.length).toBe(dupes.length);
      expect(matches[0]!.score).toBeGreaterThan(0);
    }
  });

  it('fails one lead without taking down the batch', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'hvac', location: 'Burlington, ON', requestedCount: 6, filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);

    // The discovery call itself fails, and is retryable.
    h.discovery.failNext = true;
    await tick({ sendBatch: 0, sequenceBatch: 0, aiBatch: 0, leadBatch: 5, skipMaintenance: true });

    const jobs = await h.db.select().from(leadJobs).where(eq(leadJobs.type, 'lead_discovery'));
    expect(jobs[0]!.status).toBe('PENDING');
    expect(jobs[0]!.attempts).toBe(1);
    expect(jobs[0]!.error).toContain('Mock discovery failure');

    // Made due again, it succeeds — the failure did not poison the job.
    await h.db.update(leadJobs).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(leadJobs.id, jobs[0]!.id));
    await drain();

    expect((await getSearchJob(h.ctx, search.id)).discoveredCount).toBeGreaterThan(0);
  });

  it('approves and rejects leads without moving them out of the CRM', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'plumbing', location: 'Toronto, ON', requestedCount: 6, filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const leads = await listLeads(h.ctx);
    const [first, second] = leads.rows;

    await approveLeads(h.ctx, [first!.contactId]);
    await rejectLeads(h.ctx, [second!.contactId], 'Too small');

    const detail = await getLeadDetail(h.ctx, first!.contactId);
    expect(detail.discovery?.stage).toBe('APPROVED');

    const rejected = await getLeadDetail(h.ctx, second!.contactId);
    expect(rejected.discovery?.stage).toBe('REJECTED');
    // Rejected is not deleted, and not do-not-contact.
    expect(rejected.contact.status).not.toBe('DO_NOT_CONTACT');
    expect(await h.db.select().from(contacts).where(eq(contacts.id, second!.contactId))).toHaveLength(1);
  });
});

describe('call queue and dispositions', () => {
  let h: Harness;

  async function seedCallableLeads(count = 10) {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing', location: 'Mississauga, ON', requestedCount: count,
      filters: { requirePhone: true, minReviews: 5 },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();
    const leads = await listLeads(h.ctx);
    await approveLeads(h.ctx, leads.rows.map((r) => r.contactId));
    return leads;
  }

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('builds a queue, advances it one call at a time, and survives a reload', async () => {
    await seedCallableLeads(12);

    const queue = await createCallQueue(h.ctx, {
      name: 'A-Tier Mississauga Roofing',
      filters: { minScore: 0, notCalled: true },
    });
    expect(queue.totalCount).toBeGreaterThan(0);

    const first = await currentQueuePosition(h.ctx, queue.id);
    expect(first).not.toBeNull();
    // This is the "1 of N" the operator sees.
    expect(first!.index).toBe(1);
    expect(first!.total).toBe(queue.totalCount);

    const card = await loadCallCard(h.ctx, first!.contactId);
    expect(card.contact.phone).toMatch(/^\+1\d{10}$/);
    expect(card.company?.name).toBeTruthy();
    expect(card.contact.score).not.toBeNull();

    // Call and disposition.
    const initiated = await initiateCall(h.ctx, {
      contactId: first!.contactId, queueId: queue.id, queueItemId: first!.itemId,
    });
    expect(initiated.uri).toBe(telUri(card.contact.phone));
    // Device telephony cannot observe a connection, and says so.
    expect(initiated.reportsConnection).toBe(false);

    await recordDisposition(h.ctx, {
      attemptId: initiated.attemptId,
      contactId: first!.contactId,
      outcome: 'NO_ANSWER',
      queueItemId: first!.itemId,
    });

    // "2 of N" — the queue advanced.
    const second = await currentQueuePosition(h.ctx, queue.id);
    expect(second!.index).toBe(2);
    expect(second!.total).toBe(first!.total);
    expect(second!.contactId).not.toBe(first!.contactId);

    // Position is persisted, so reopening the browser resumes where it was.
    const reloaded = await currentQueuePosition(h.ctx, queue.id);
    expect(reloaded!.contactId).toBe(second!.contactId);
    expect(reloaded!.index).toBe(2);
  });

  it('orders the queue by priority, best leads first', async () => {
    await seedCallableLeads(15);
    const queue = await createCallQueue(h.ctx, { name: 'Priority', filters: {} });

    const items = await h.db
      .select()
      .from(callQueueItems)
      .where(eq(callQueueItems.queueId, queue.id))
      .orderBy(callQueueItems.position);

    const scores = items.map((i) => i.priorityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // Stored, so the ordering is explainable after the fact.
    expect(items[0]!.priorityScore).toBeGreaterThan(0);
  });

  it('handles every primary disposition', async () => {
    await seedCallableLeads(12);
    const queue = await createCallQueue(h.ctx, { name: 'Dispositions', filters: {} });

    // BOOKED
    let position = (await currentQueuePosition(h.ctx, queue.id))!;
    let attempt = await initiateCall(h.ctx, { contactId: position.contactId, queueId: queue.id, queueItemId: position.itemId });
    await recordDisposition(h.ctx, {
      attemptId: attempt.attemptId, contactId: position.contactId, outcome: 'BOOKED',
      note: 'Wants a demo Thursday', queueItemId: position.itemId,
    });
    let contact = (await h.db.select().from(contacts).where(eq(contacts.id, position.contactId)))[0]!;
    expect(contact.status).toBe('APPOINTMENT');
    expect(contact.callReadiness).toBe('COMPLETED');

    // CALLBACK — schedules a real task.
    position = (await currentQueuePosition(h.ctx, queue.id))!;
    const callbackAt = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    attempt = await initiateCall(h.ctx, { contactId: position.contactId, queueId: queue.id, queueItemId: position.itemId });
    await recordDisposition(h.ctx, {
      attemptId: attempt.attemptId, contactId: position.contactId, outcome: 'CALLBACK',
      callbackAt, queueItemId: position.itemId,
    });
    contact = (await h.db.select().from(contacts).where(eq(contacts.id, position.contactId)))[0]!;
    expect(contact.nextCallbackAt?.toISOString()).toBe(callbackAt.toISOString());
    const { tasks } = await import('@/lib/db/schema');
    const openTasks = await h.db.select().from(tasks).where(eq(tasks.contactId, position.contactId));
    expect(openTasks[0]!.title).toContain('Call back');

    // A callback needs a time.
    const another = (await currentQueuePosition(h.ctx, queue.id))!;
    await expect(
      recordDisposition(h.ctx, { contactId: another.contactId, outcome: 'CALLBACK' }),
    ).rejects.toThrow(/date and time/i);

    // NOT_INTERESTED
    position = (await currentQueuePosition(h.ctx, queue.id))!;
    attempt = await initiateCall(h.ctx, { contactId: position.contactId, queueId: queue.id, queueItemId: position.itemId });
    await recordDisposition(h.ctx, {
      attemptId: attempt.attemptId, contactId: position.contactId, outcome: 'NOT_INTERESTED',
      notInterestedReason: 'Already has a solution', queueItemId: position.itemId,
    });
    contact = (await h.db.select().from(contacts).where(eq(contacts.id, position.contactId)))[0]!;
    expect(contact.status).toBe('LOST');

    // WRONG_NUMBER retires the number but keeps the business.
    position = (await currentQueuePosition(h.ctx, queue.id))!;
    const wrongContactId = position.contactId;
    attempt = await initiateCall(h.ctx, { contactId: wrongContactId, queueId: queue.id, queueItemId: position.itemId });
    await recordDisposition(h.ctx, {
      attemptId: attempt.attemptId, contactId: wrongContactId, outcome: 'WRONG_NUMBER', queueItemId: position.itemId,
    });
    contact = (await h.db.select().from(contacts).where(eq(contacts.id, wrongContactId)))[0]!;
    expect(contact.phoneInvalid).toBe(true);
    expect(contact.status).toBe('DO_NOT_CONTACT');
    // The company record survives.
    expect(await h.db.select().from(companies).where(eq(companies.id, contact.companyId!))).toHaveLength(1);

    // And it can never be dialled again.
    await expect(initiateCall(h.ctx, { contactId: wrongContactId })).rejects.toThrow(/wrong|do-not-contact/i);
  });

  it('skips without losing the lead', async () => {
    await seedCallableLeads(6);
    const queue = await createCallQueue(h.ctx, { name: 'Skips', filters: {} });

    const position = (await currentQueuePosition(h.ctx, queue.id))!;
    await skipQueueItem(h.ctx, position.itemId, 'Need research');

    const next = await currentQueuePosition(h.ctx, queue.id);
    expect(next!.contactId).not.toBe(position.contactId);
    // The prospect is still in the database, untouched.
    expect(await h.db.select().from(contacts).where(eq(contacts.id, position.contactId))).toHaveLength(1);
  });

  it('never claims a call connected that it did not observe', async () => {
    await seedCallableLeads(6);
    const queue = await createCallQueue(h.ctx, { name: 'Honesty', filters: {} });
    const position = (await currentQueuePosition(h.ctx, queue.id))!;

    const attempt = await initiateCall(h.ctx, {
      contactId: position.contactId, queueId: queue.id, queueItemId: position.itemId,
    });

    const { callAttempts } = await import('@/lib/db/schema');
    let row = (await h.db.select().from(callAttempts).where(eq(callAttempts.id, attempt.attemptId)))[0]!;
    // The only thing that is true at this point.
    expect(row.outcome).toBe('INITIATED');
    expect(row.connectionReported).toBe(false);

    // Even when the human marks a connected outcome, it is their report — not
    // telemetry the system observed.
    await recordDisposition(h.ctx, {
      attemptId: attempt.attemptId, contactId: position.contactId, outcome: 'BOOKED', queueItemId: position.itemId,
    });
    row = (await h.db.select().from(callAttempts).where(eq(callAttempts.id, attempt.attemptId)))[0]!;
    expect(row.outcome).toBe('BOOKED');
    expect(row.connectionReported).toBe(false);

    const metrics = await callMetrics(h.ctx, daysAgo(1));
    expect(metrics.attempted).toBe(1);
    expect(metrics.booked).toBe(1);
    // No provider reported a connection, so no connect rate is published.
    expect(metrics.connectRateObservable).toBe(false);
    expect(metrics.reportedConnected).toBe(0);
    expect(metrics.operatorReportedContactRate).toBe(100);
  });

  it('keeps a full call history on the prospect', async () => {
    await seedCallableLeads(4);
    const queue = await createCallQueue(h.ctx, { name: 'History', filters: {} });
    const position = (await currentQueuePosition(h.ctx, queue.id))!;

    const first = await initiateCall(h.ctx, { contactId: position.contactId, queueId: queue.id, queueItemId: position.itemId });
    await recordDisposition(h.ctx, {
      attemptId: first.attemptId, contactId: position.contactId, outcome: 'NO_ANSWER',
      note: 'Rang out', queueItemId: position.itemId,
    });

    const second = await initiateCall(h.ctx, { contactId: position.contactId });
    await recordDisposition(h.ctx, {
      attemptId: second.attemptId, contactId: position.contactId, outcome: 'BOOKED', note: 'Owner answered',
    });

    const history = await listCallHistory(h.ctx, position.contactId);
    expect(history).toHaveLength(2);
    expect(history[0]!.outcome).toBe('BOOKED');
    expect(history[0]!.note).toBe('Owner answered');
    expect(history[1]!.outcome).toBe('NO_ANSWER');
  });

  it('excludes suppressed numbers from queues and from dialling', async () => {
    await seedCallableLeads(8);
    const leads = await listLeads(h.ctx, { filters: { view: 'CALL_READY' } });
    const target = leads.rows[0]!;

    const { suppress } = await import('@/lib/services/suppression');
    await suppress(h.ctx, { phone: target.phone, reason: 'MANUAL', contactId: target.contactId });

    const queue = await createCallQueue(h.ctx, { name: 'Suppression', filters: {} });
    const items = await h.db.select().from(callQueueItems).where(eq(callQueueItems.queueId, queue.id));
    expect(items.map((i) => i.contactId)).not.toContain(target.contactId);
    // The suppressed number is the ONLY one excluded. Without this the test
    // would also pass on a queue that came back empty for an unrelated reason.
    expect(items).toHaveLength(leads.rows.length - 1);

    await expect(initiateCall(h.ctx, { contactId: target.contactId })).rejects.toThrow(/do-not-contact/i);
  });

  /**
   * Drizzle renders a column without its table qualifier when the outer query
   * has no join, so `${callQueues.id}` inside a raw subquery over
   * `call_queue_items` used to bind to that table's own id — a correlation that
   * silently counted zero instead of failing. These assert the counts are real,
   * because a wrong count here is invisible: the page just shows a plausible
   * number.
   */
  it('counts what is left in a queue rather than always zero', async () => {
    await seedCallableLeads(6);
    const queue = await createCallQueue(h.ctx, { name: 'Counting', filters: {} });

    const before = await listCallQueues(h.ctx);
    const row = before.find((q) => q.queue.id === queue.id)!;
    expect(row.queue.totalCount).toBe(6);
    expect(row.remaining).toBe(6);

    const position = (await currentQueuePosition(h.ctx, queue.id))!;
    await recordDisposition(h.ctx, {
      contactId: position.contactId,
      outcome: 'NO_ANSWER',
      queueItemId: position.itemId,
    });
    await skipQueueItem(h.ctx, (await currentQueuePosition(h.ctx, queue.id))!.itemId, 'Bad timing');

    const after = await listCallQueues(h.ctx);
    expect(after.find((q) => q.queue.id === queue.id)!.remaining).toBe(4);
  });

  it("counts a campaign's prospects rather than always zero", async () => {
    const { enrollProspects, listCampaigns } = await import('@/lib/services/campaigns');
    await seedCallableLeads(4);
    const leads = await listLeads(h.ctx, { filters: { view: 'CALL_READY' } });

    await enrollProspects(h.ctx, h.campaignId, leads.rows.map((r) => r.contactId));

    const campaigns = await listCampaigns(h.ctx);
    const campaign = campaigns.find((c) => c.campaign.id === h.campaignId)!;
    expect(campaign.prospects).toBe(leads.rows.length);
  });
});

describe('tel: URI generation', () => {
  it('builds a dialable URI and refuses what cannot be dialled', () => {
    expect(telUri('+14165550142')).toBe('tel:+14165550142');
    expect(telUri('(416) 555-0142')).toBe('tel:4165550142');
    // Anything that is not a digit is stripped, so a stored value cannot turn
    // into something else in a URI the operating system will act on.
    expect(telUri('+1 416 555 0142 ext. 5')).toBe('tel:+141655501425');
    expect(telUri('123')).toBeNull();
    expect(telUri('')).toBeNull();
  });
});
