import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { contacts, leadSearchJobs } from '@/lib/db/schema';
import { MockDiscoveryProvider, getDiscoveryProvider, setDiscoveryProvider } from '@/lib/lead-generation/providers';
import { createSearchJob, startSearchJob } from '@/lib/services/lead-search';
import { approveLeads, listLeads } from '@/lib/services/leads';
import { createCallQueue } from '@/lib/services/call-queue';
import { runLeadJobs } from '@/lib/worker/lead-worker';
import type { Ctx } from '@/lib/auth/context';

export type CallDemoResult = {
  searches: number;
  leads: number;
  callReady: number;
  queueId: string | null;
  queueSize: number;
};

/**
 * Seeds a demo book of call-ready leads.
 *
 * It runs the real pipeline — discovery, dedupe, promotion, crawl, research,
 * scoring, personalization — against the synthetic provider, rather than
 * inserting rows that look like its output. Demo data that skipped the pipeline
 * would hide exactly the bugs a demo is supposed to surface.
 *
 * The provider is forced to the mock one for the duration: seeding must never
 * spend money on a live discovery API, and every number it produces is in the
 * 555-01xx range reserved for fiction.
 */
export async function seedCallDemo(
  ctx: Ctx,
  options: { searches?: Array<{ query: string; location: string; count: number }>; queueName?: string } = {},
): Promise<CallDemoResult> {
  const db = getDb();

  const searches = options.searches ?? [
    { query: 'roofing', location: 'Mississauga, ON', count: 75 },
    { query: 'plumbing', location: 'Brampton, ON', count: 60 },
    { query: 'hvac', location: 'Oakville, ON', count: 55 },
  ];

  const previous = getDiscoveryProvider();
  setDiscoveryProvider(new MockDiscoveryProvider());

  try {
    for (const search of searches) {
      const job = await createSearchJob(ctx, {
        query: search.query,
        location: search.location,
        requestedCount: search.count,
        filters: { requirePhone: true },
      });
      await startSearchJob(ctx, job.id);
    }

    // Drain the queue the same way the worker does, with a bound so a bug in a
    // stage cannot turn seeding into an infinite loop.
    for (let pass = 0; pass < 200; pass += 1) {
      const result = await runLeadJobs(50, `seed-${pass}`);
      if (result.claimed === 0) break;
    }

    const leads = await listLeads(ctx, { pageSize: 200 });
    const ids = leads.rows.map((row) => row.contactId);
    if (ids.length > 0) {
      await approveLeads(ctx, ids);
      // Marked so the UI can label it and a real deployment can delete it.
      await db.update(contacts).set({ isDemo: true }).where(inArray(contacts.id, ids));
    }

    const ready = await listLeads(ctx, { filters: { view: 'CALL_READY' }, pageSize: 500 });

    let queueId: string | null = null;
    let queueSize = 0;
    if (ready.rows.length > 0) {
      const queue = await createCallQueue(ctx, {
        name: options.queueName ?? "Today's calls",
        description: 'Built from the demo lead searches',
        filters: { limit: 500 },
      });
      queueId = queue.id;
      queueSize = queue.totalCount;
    }

    const jobCount = await db
      .select({ id: leadSearchJobs.id })
      .from(leadSearchJobs)
      .where(eq(leadSearchJobs.organizationId, ctx.organizationId));

    return {
      searches: jobCount.length,
      leads: ids.length,
      callReady: ready.total,
      queueId,
      queueSize,
    };
  } finally {
    setDiscoveryProvider(previous);
  }
}
