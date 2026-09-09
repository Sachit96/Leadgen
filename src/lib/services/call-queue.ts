import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { outer } from '@/lib/db/sql';
import { getDb } from '@/lib/db';
import {
  callAttempts,
  callQueueItems,
  callQueues,
  companies,
  contacts,
  leadPersonalization,
  suppressionEntries,
} from '@/lib/db/schema';
import { invalid, notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import type { Ctx } from '@/lib/auth/context';
import type { CallQueue } from '@/lib/db/types';
import { recordActivity } from './activity';

/**
 * Call queues.
 *
 * Persisted rather than held in the browser: an operator who reloads or closes
 * the tab mid-session must come back to "37 of 155", not to the start. Position
 * is a stable integer on the row, so "N of M" is read, never recomputed from
 * client state.
 */
export type QueueFilters = {
  minScore?: number;
  buckets?: string[];
  industries?: string[];
  cities?: string[];
  campaignId?: string;
  minReviews?: number;
  minRating?: number;
  /** Exclude anyone already called. */
  notCalled?: boolean;
  /** Exclude anyone contacted in the last N days. */
  notContactedWithinDays?: number;
  requireOwner?: boolean;
  requirePersonalization?: boolean;
  assignedUserId?: string;
  limit?: number;
};

export type CreateQueueInput = {
  name: string;
  description?: string | null;
  filters: QueueFilters;
  assignedUserId?: string | null;
  campaignId?: string | null;
};

const DEFAULT_QUEUE_LIMIT = 200;
const MAX_QUEUE_LIMIT = 1000;

export async function createCallQueue(ctx: Ctx, input: CreateQueueInput): Promise<CallQueue> {
  assertCan(ctx.role, 'prospect:write');
  const name = input.name.trim();
  if (!name) throw invalid('Give the queue a name');

  const [queue] = await getDb()
    .insert(callQueues)
    .values({
      organizationId: ctx.organizationId,
      name,
      description: input.description ?? null,
      filters: input.filters,
      assignedUserId: input.assignedUserId ?? ctx.user?.userId ?? null,
      campaignId: input.campaignId ?? null,
      createdByUserId: ctx.user?.userId ?? null,
    })
    .returning();

  await buildQueueFromFilters(ctx, queue!.id);
  return getCallQueue(ctx, queue!.id);
}

/**
 * Priority ordering.
 *
 * Highest ICP first, then the things that make a call more likely to go
 * somewhere: a confident phone number, a named owner to ask for, real review
 * volume, and a ready opening line. Expressed as a single SQL expression so
 * ordering happens in the database, and stored per item so the order is
 * explainable afterwards.
 */
const PRIORITY_EXPRESSION = sql<number>`(
  coalesce(${contacts.score}, 0) * 1.0
  + coalesce(${contacts.phoneConfidence}, 0) * 20
  + (case when ${companies.ownerName} is not null then 15 else 0 end)
  + least(coalesce(${companies.googleReviews}, 0) / 20.0, 10)
  + (case when ${contacts.callAttemptCount} = 0 then 10 else 0 end)
  - ${contacts.noAnswerCount} * 5
)`;

/** Rebuilds the queue's items from its stored filters. Idempotent. */
export async function buildQueueFromFilters(ctx: Ctx, queueId: string): Promise<number> {
  const db = getDb();
  const queue = await getCallQueue(ctx, queueId);
  const filters = (queue.filters ?? {}) as QueueFilters;

  const clauses: SQL[] = [
    eq(contacts.organizationId, ctx.organizationId),
    // Only leads that pass the readiness gate: a valid number, a company, an
    // industry, a location and a score.
    eq(contacts.callReadiness, 'READY'),
    eq(contacts.phoneInvalid, false),
    ne(contacts.status, 'DO_NOT_CONTACT'),
    // The same suppression list that gates SMS gates calling.
    sql`not exists (
      select 1 from ${suppressionEntries} s
      where s.organization_id = ${ctx.organizationId} and s.phone = ${contacts.phone}
    )`,
  ];

  if (filters.minScore !== undefined) clauses.push(gte(contacts.score, filters.minScore));
  if (filters.buckets?.length) clauses.push(inArray(contacts.scoreBucket, filters.buckets));
  if (filters.industries?.length) clauses.push(inArray(companies.industry, filters.industries));
  if (filters.cities?.length) clauses.push(inArray(companies.city, filters.cities));
  if (filters.minReviews !== undefined) clauses.push(gte(companies.googleReviews, filters.minReviews));
  if (filters.minRating !== undefined) clauses.push(gte(companies.googleRating, filters.minRating));
  if (filters.assignedUserId) clauses.push(eq(contacts.ownerUserId, filters.assignedUserId));
  if (filters.requireOwner) clauses.push(sql`${companies.ownerName} is not null`);
  if (filters.notCalled) clauses.push(eq(contacts.callAttemptCount, 0));

  if (filters.notContactedWithinDays !== undefined) {
    const cutoff = new Date(Date.now() - filters.notContactedWithinDays * 24 * 60 * 60_000);
    const clause = or(isNull(contacts.lastCallAt), sql`${contacts.lastCallAt} < ${cutoff}`);
    if (clause) clauses.push(clause);
  }

  if (filters.requirePersonalization) {
    clauses.push(
      sql`exists (select 1 from ${leadPersonalization} lp where lp.contact_id = ${contacts.id})`,
    );
  }

  // Never re-add someone already in this queue.
  const existing = await db
    .select({ contactId: callQueueItems.contactId })
    .from(callQueueItems)
    .where(eq(callQueueItems.queueId, queueId));
  if (existing.length > 0) {
    clauses.push(notInArray(contacts.id, existing.map((e) => e.contactId)));
  }

  const limit = Math.min(MAX_QUEUE_LIMIT, filters.limit ?? DEFAULT_QUEUE_LIMIT);

  const candidates = await db
    .select({ id: contacts.id, priority: PRIORITY_EXPRESSION })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(...clauses))
    .orderBy(desc(PRIORITY_EXPRESSION))
    .limit(limit);

  if (candidates.length === 0) return 0;

  // Positions continue from whatever is already there.
  const maxRows = await db
    .select({ max: sql<number>`coalesce(max(${callQueueItems.position}), 0)::int` })
    .from(callQueueItems)
    .where(eq(callQueueItems.queueId, queueId));
  let position = maxRows[0]?.max ?? 0;

  const inserted = await db
    .insert(callQueueItems)
    .values(
      candidates.map((candidate) => ({
        organizationId: ctx.organizationId,
        queueId,
        contactId: candidate.id,
        position: ++position,
        priorityScore: Number(candidate.priority ?? 0),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: callQueueItems.id, contactId: callQueueItems.contactId });

  await db
    .update(contacts)
    .set({ callReadiness: 'QUEUED', updatedAt: new Date() })
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        inArray(contacts.id, inserted.map((i) => i.contactId)),
      ),
    );

  await db
    .update(callQueues)
    .set({
      totalCount: sql`${callQueues.totalCount} + ${inserted.length}`,
      updatedAt: new Date(),
    })
    .where(eq(callQueues.id, queueId));

  for (const item of inserted) {
    await recordActivity(ctx, {
      type: 'call_queue_added',
      title: `Added to call queue "${queue.name}"`,
      contactId: item.contactId,
      metadata: { queueId },
    });
  }

  return inserted.length;
}

export async function getCallQueue(ctx: Ctx, id: string): Promise<CallQueue> {
  const rows = await getDb()
    .select()
    .from(callQueues)
    .where(and(eq(callQueues.id, id), eq(callQueues.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Call queue');
  return row;
}

export async function listCallQueues(ctx: Ctx) {
  return getDb()
    .select({
      queue: callQueues,
      remaining: sql<number>`(
        select count(*)::int from ${callQueueItems} i
        where i.queue_id = ${outer(callQueues.id)} and i.status in ('PENDING','CURRENT')
      )`,
    })
    .from(callQueues)
    .where(and(eq(callQueues.organizationId, ctx.organizationId), ne(callQueues.status, 'ARCHIVED')))
    .orderBy(desc(callQueues.createdAt));
}

export type QueuePosition = {
  itemId: string;
  contactId: string;
  /** 1-based index among the items still to work — the "N" in "N of M". */
  index: number;
  total: number;
};

/**
 * The next lead to call.
 *
 * `index` counts completed work rather than the raw position, so skipping does
 * not leave gaps in what the operator sees.
 */
export async function currentQueuePosition(ctx: Ctx, queueId: string): Promise<QueuePosition | null> {
  const db = getDb();

  const totals = await db
    .select({
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${callQueueItems.status} in ('COMPLETED','SKIPPED'))::int`,
    })
    .from(callQueueItems)
    .where(and(eq(callQueueItems.queueId, queueId), eq(callQueueItems.organizationId, ctx.organizationId)));

  const total = totals[0]?.total ?? 0;
  const done = totals[0]?.done ?? 0;
  if (total === 0) return null;

  const rows = await db
    .select({ id: callQueueItems.id, contactId: callQueueItems.contactId })
    .from(callQueueItems)
    .where(
      and(
        eq(callQueueItems.queueId, queueId),
        eq(callQueueItems.organizationId, ctx.organizationId),
        inArray(callQueueItems.status, ['PENDING', 'CURRENT']),
      ),
    )
    .orderBy(asc(callQueueItems.position))
    .limit(1);

  const next = rows[0];
  if (!next) return null;

  return { itemId: next.id, contactId: next.contactId, index: done + 1, total };
}

/** Everything the call screen needs, in one round trip. */
export async function loadCallCard(ctx: Ctx, contactId: string) {
  const db = getDb();

  const rows = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Prospect');

  const [personalization, history] = await Promise.all([
    db
      .select()
      .from(leadPersonalization)
      .where(eq(leadPersonalization.contactId, contactId))
      .orderBy(desc(leadPersonalization.createdAt))
      .limit(1),
    db
      .select()
      .from(callAttempts)
      .where(eq(callAttempts.contactId, contactId))
      .orderBy(desc(callAttempts.startedAt))
      .limit(10),
  ]);

  return {
    contact: row.contact,
    company: row.company,
    personalization: personalization[0] ?? null,
    history,
  };
}

export async function markItemCurrent(ctx: Ctx, itemId: string): Promise<void> {
  await getDb()
    .update(callQueueItems)
    .set({ status: 'CURRENT' })
    .where(
      and(
        eq(callQueueItems.id, itemId),
        eq(callQueueItems.organizationId, ctx.organizationId),
        eq(callQueueItems.status, 'PENDING'),
      ),
    );
}

export async function skipQueueItem(ctx: Ctx, itemId: string, reason: string): Promise<void> {
  assertCan(ctx.role, 'prospect:write');
  const db = getDb();

  const rows = await db
    .select()
    .from(callQueueItems)
    .where(and(eq(callQueueItems.id, itemId), eq(callQueueItems.organizationId, ctx.organizationId)))
    .limit(1);
  const item = rows[0];
  if (!item) throw notFound('Queue item');

  await db
    .update(callQueueItems)
    .set({ status: 'SKIPPED', skipReason: reason, completedAt: new Date() })
    .where(eq(callQueueItems.id, itemId));

  await db
    .update(callQueues)
    .set({ skippedCount: sql`${callQueues.skippedCount} + 1`, updatedAt: new Date() })
    .where(eq(callQueues.id, item.queueId));

  // The lead stays in the database; only its place in this queue changes.
  await recordActivity(ctx, {
    type: 'call_skipped',
    title: `Skipped in call queue: ${reason}`,
    contactId: item.contactId,
    metadata: { queueId: item.queueId, reason },
  });
}

export async function removeFromQueue(ctx: Ctx, itemId: string): Promise<void> {
  assertCan(ctx.role, 'prospect:write');
  const db = getDb();
  const rows = await db
    .select()
    .from(callQueueItems)
    .where(and(eq(callQueueItems.id, itemId), eq(callQueueItems.organizationId, ctx.organizationId)))
    .limit(1);
  const item = rows[0];
  if (!item) return;

  await db.update(callQueueItems).set({ status: 'REMOVED' }).where(eq(callQueueItems.id, itemId));
  await recordActivity(ctx, {
    type: 'call_queue_removed',
    title: 'Removed from call queue',
    contactId: item.contactId,
    metadata: { queueId: item.queueId },
  });
}

export async function addToQueue(ctx: Ctx, queueId: string, contactIds: string[]): Promise<number> {
  assertCan(ctx.role, 'prospect:write');
  if (contactIds.length === 0) return 0;
  const db = getDb();
  await getCallQueue(ctx, queueId);

  const maxRows = await db
    .select({ max: sql<number>`coalesce(max(${callQueueItems.position}), 0)::int` })
    .from(callQueueItems)
    .where(eq(callQueueItems.queueId, queueId));
  let position = maxRows[0]?.max ?? 0;

  const eligible = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        inArray(contacts.id, contactIds),
        eq(contacts.phoneInvalid, false),
        ne(contacts.status, 'DO_NOT_CONTACT'),
      ),
    );

  const inserted = await db
    .insert(callQueueItems)
    .values(
      eligible.map((contact) => ({
        organizationId: ctx.organizationId,
        queueId,
        contactId: contact.id,
        position: ++position,
      })),
    )
    .onConflictDoNothing()
    .returning({ contactId: callQueueItems.contactId });

  if (inserted.length > 0) {
    await db
      .update(contacts)
      .set({ callReadiness: 'QUEUED', updatedAt: new Date() })
      .where(
        and(
          eq(contacts.organizationId, ctx.organizationId),
          inArray(contacts.id, inserted.map((i) => i.contactId)),
          eq(contacts.callReadiness, 'READY'),
        ),
      );

    await db
      .update(callQueues)
      .set({ totalCount: sql`${callQueues.totalCount} + ${inserted.length}`, updatedAt: new Date() })
      .where(eq(callQueues.id, queueId));
  }

  return inserted.length;
}

export async function setQueueStatus(
  ctx: Ctx,
  queueId: string,
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED',
): Promise<void> {
  assertCan(ctx.role, 'prospect:write');
  await getDb()
    .update(callQueues)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(callQueues.id, queueId), eq(callQueues.organizationId, ctx.organizationId)));
}
