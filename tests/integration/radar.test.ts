import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { radarSnapshot } from '@/lib/services/radar';
import { createSearchJob, startSearchJob } from '@/lib/services/lead-search';
import { approveLeads, listLeads } from '@/lib/services/leads';
import { tick } from '@/lib/worker/tick';

async function drain(maxTicks = 60): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await tick({ sendBatch: 0, sequenceBatch: 0, aiBatch: 0, leadBatch: 25, skipMaintenance: true });
    if (result.leads.claimed === 0) return;
  }
}

/**
 * The control room is an instrument, so its failure mode is a plausible wrong
 * reading rather than a crash. These pin the two ways that happens: a rate
 * computed over the wrong denominator, and a rate invented where there is no
 * denominator at all.
 */
describe('control room', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('reads zero on an organization that has done nothing, and claims no rates', async () => {
    const snapshot = await radarSnapshot(h.ctx, 'all');

    expect(snapshot.stages).toHaveLength(10);
    expect(snapshot.stages.every((stage) => stage.value === 0)).toBe(true);
    // A percentage of nothing is unknown, not zero — every denominator is empty.
    expect(snapshot.stages.every((stage) => stage.flow === null)).toBe(true);
    expect(snapshot.thread).toBeNull();
    expect(snapshot.headline.conversion).toBe(0);
    // The ten stages in the five pairs the pipeline actually runs in.
    expect(snapshot.groups).toEqual(['Acquisition', 'Assessment', 'Outreach', 'Conversion', 'Results']);
  });

  it('never reports a conversion above 100%', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 12,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const leads = await listLeads(h.ctx, { filters: { view: 'REVIEW' } });
    await approveLeads(h.ctx, leads.rows.map((row) => row.contactId));

    const snapshot = await radarSnapshot(h.ctx, 'all');
    const byKey = Object.fromEntries(snapshot.stages.map((stage) => [stage.key, stage]));

    // Research runs on leads whose website never loaded, working from the
    // discovery data alone. Measuring it against *crawled* made it look like
    // more leads came out of the stage than went in — 119.4% converted.
    expect(byKey.intelligence!.value).toBeGreaterThanOrEqual(byKey.enrichment!.value);
    for (const stage of snapshot.stages) {
      if (stage.flow === null) continue;
      expect(stage.flow, `${stage.key} reported ${stage.flow}%`).toBeGreaterThanOrEqual(0);
      expect(stage.flow, `${stage.key} reported ${stage.flow}%`).toBeLessThanOrEqual(100);
    }

    // Each rate says what it is a rate of, so none of them is ambiguous.
    for (const stage of snapshot.stages) {
      if (stage.flow === null) continue;
      expect(stage.flowOf, `${stage.key} has an unlabelled rate`).toBeTruthy();
    }
  }, 120_000);

  it('counts what the pipeline wrote, and carries a real thread', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 10,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const snapshot = await radarSnapshot(h.ctx, 'all');
    const byKey = Object.fromEntries(snapshot.stages.map((stage) => [stage.key, stage]));

    const { leadSearchJobs, leadSignals } = await import('@/lib/db/schema');
    const runs = await h.db.select().from(leadSearchJobs);
    const discovered = runs.reduce((sum, run) => sum + run.discoveredCount, 0);

    // Not "about right" — the same number the run recorded.
    expect(byKey.lead_generation!.value).toBe(discovered);
    expect(byKey.lead_generation!.display).toBe(discovered.toLocaleString());

    const signals = await h.db.select().from(leadSignals);
    expect(snapshot.headline.signals).toBe(signals.filter((s) => s.detected).length);

    // Nothing has been sent, so the outreach half is honestly empty.
    expect(byKey.sms!.value).toBe(0);
    expect(snapshot.thread).toBeNull();
  }, 120_000);

  it('shows the real conversation once one exists', async () => {
    const { createProspect } = await import('@/lib/services/contacts');
    const { getOrCreateConversation } = await import('@/lib/services/conversations');
    const { queueOutbound } = await import('@/lib/services/messages');

    const prospect = await createProspect(h.ctx, {
      phone: '4165550188',
      company: { name: 'Ridgeline Roofing', city: 'Toronto', industry: 'Roofing' },
    });
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);
    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Quick question about the estimates that never closed.',
      author: 'AI',
      idempotencyKey: 'radar-thread',
    });
    await tick({ sequenceBatch: 0, aiBatch: 0, leadBatch: 0, skipMaintenance: true });

    const snapshot = await radarSnapshot(h.ctx, 'all');
    expect(snapshot.thread).not.toBeNull();
    expect(snapshot.thread!.companyName).toBe('Ridgeline Roofing');
    // The message body is the one that was actually sent — no sample transcript.
    expect(snapshot.thread!.turns.at(-1)!.body).toBe(
      'Quick question about the estimates that never closed.',
    );
    expect(snapshot.thread!.turns.at(-1)!.direction).toBe('OUTBOUND');
  }, 120_000);
});
