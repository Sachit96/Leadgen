import { and, desc, eq, gt, inArray, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  aiSummaries,
  campaigns,
  companies,
  contacts,
  conversations,
  messages,
  qualifications,
  users,
} from '@/lib/db/schema';
import { notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import { recordActivity } from './activity';
import { notify } from './notifications';
import type { Ctx } from '@/lib/auth/context';
import type { Conversation, ConversationState, Intent, LeadTemperature } from '@/lib/db/types';

/** States in which no automated message may be produced or sent. */
export const STOPPED_STATES: ConversationState[] = ['DO_NOT_CONTACT', 'NOT_INTERESTED', 'CLOSED'];

export function isStopped(state: ConversationState): boolean {
  return STOPPED_STATES.includes(state);
}

export async function getOrCreateConversation(
  ctx: Ctx,
  contactId: string,
  options: { campaignId?: string | null; phoneNumberId?: string | null } = {},
): Promise<Conversation> {
  const db = getDb();
  const existing = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.contactId, contactId)),
    )
    .limit(1);

  if (existing[0]) {
    // Attach the campaign on first touch so attribution is set from the start.
    if (options.campaignId && !existing[0].campaignId) {
      const [updated] = await db
        .update(conversations)
        .set({ campaignId: options.campaignId, updatedAt: new Date() })
        .where(eq(conversations.id, existing[0].id))
        .returning();
      return updated!;
    }
    return existing[0];
  }

  const [created] = await db
    .insert(conversations)
    .values({
      organizationId: ctx.organizationId,
      contactId,
      campaignId: options.campaignId ?? null,
      phoneNumberId: options.phoneNumberId ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Lost a race with a concurrent inbound webhook — re-read the winner.
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.contactId, contactId)),
    )
    .limit(1);
  if (!row) throw notFound('Conversation');
  return row;
}

export async function getConversation(ctx: Ctx, id: string) {
  const rows = await getDb()
    .select({
      conversation: conversations,
      contact: contacts,
      company: companies,
      campaign: campaigns,
      assignee: { id: users.id, name: users.name },
      qualification: qualifications,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(campaigns, eq(campaigns.id, conversations.campaignId))
    .leftJoin(users, eq(users.id, conversations.assignedUserId))
    .leftJoin(qualifications, eq(qualifications.conversationId, conversations.id))
    .where(and(eq(conversations.id, id), eq(conversations.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Conversation');
  return row;
}

export async function latestSummary(ctx: Ctx, conversationId: string) {
  const rows = await getDb()
    .select()
    .from(aiSummaries)
    .where(
      and(
        eq(aiSummaries.organizationId, ctx.organizationId),
        eq(aiSummaries.conversationId, conversationId),
      ),
    )
    .orderBy(desc(aiSummaries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export type InboxFilter =
  | 'all'
  | 'unread'
  | 'needs_human'
  | 'hot'
  | 'ai_active'
  | 'booked'
  | 'closed'
  | 'mine';

export type InboxRow = {
  id: string;
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  companyName: string | null;
  companyCity: string | null;
  state: ConversationState;
  intent: Intent;
  leadTemperature: LeadTemperature;
  aiEnabled: boolean;
  requiresHuman: boolean;
  handoffReason: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessageBody: string | null;
  lastMessageDirection: string | null;
  campaignName: string | null;
  assignedUserId: string | null;
  score: number | null;
  scoreBucket: string | null;
};

export async function listInbox(
  ctx: Ctx,
  options: { filter?: InboxFilter; search?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: InboxRow[]; total: number }> {
  const limit = Math.min(100, options.limit ?? 40);
  const offset = options.offset ?? 0;
  const clauses: SQL[] = [eq(conversations.organizationId, ctx.organizationId)];

  switch (options.filter) {
    case 'unread':
      clauses.push(gt(conversations.unreadCount, 0));
      break;
    case 'needs_human':
      clauses.push(eq(conversations.requiresHuman, true));
      break;
    case 'hot':
      clauses.push(eq(conversations.leadTemperature, 'hot'));
      break;
    case 'ai_active':
      clauses.push(eq(conversations.aiEnabled, true));
      break;
    case 'booked':
      clauses.push(inArray(conversations.state, ['APPOINTMENT', 'BOOKED']));
      break;
    case 'closed':
      clauses.push(inArray(conversations.state, STOPPED_STATES));
      break;
    case 'mine':
      clauses.push(eq(conversations.assignedUserId, ctx.userId));
      break;
    default:
      // "all" still hides finished conversations; use the closed filter for those.
      clauses.push(sql`${conversations.state} not in ('CLOSED','DO_NOT_CONTACT')`);
  }

  if (options.search?.trim()) {
    const term = `%${options.search.trim()}%`;
    const combined = or(
      sql`${contacts.firstName} ilike ${term}`,
      sql`${contacts.lastName} ilike ${term}`,
      sql`${contacts.phone} ilike ${term}`,
      sql`${companies.name} ilike ${term}`,
    );
    if (combined) clauses.push(combined);
  }

  const db = getDb();

  // Correlated subqueries for the preview keep this a single round trip and
  // avoid loading every message just to show the latest line.
  const lastBody = sql<string | null>`(
    select m.body from ${messages} m
    where m.conversation_id = ${conversations.id}
    order by m.created_at desc limit 1
  )`;
  const lastDirection = sql<string | null>`(
    select m.direction::text from ${messages} m
    where m.conversation_id = ${conversations.id}
    order by m.created_at desc limit 1
  )`;

  const rows = await db
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      companyName: companies.name,
      companyCity: companies.city,
      state: conversations.state,
      intent: conversations.intent,
      leadTemperature: conversations.leadTemperature,
      aiEnabled: conversations.aiEnabled,
      requiresHuman: conversations.requiresHuman,
      handoffReason: conversations.handoffReason,
      unreadCount: conversations.unreadCount,
      lastMessageAt: conversations.lastMessageAt,
      lastMessageBody: lastBody,
      lastMessageDirection: lastDirection,
      campaignName: campaigns.name,
      assignedUserId: conversations.assignedUserId,
      score: contacts.score,
      scoreBucket: contacts.scoreBucket,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(campaigns, eq(campaigns.id, conversations.campaignId))
    .where(and(...clauses))
    .orderBy(
      desc(conversations.requiresHuman),
      sql`${conversations.lastMessageAt} desc nulls last`,
    )
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(...clauses));

  return { rows, total: countRows[0]?.count ?? 0 };
}

export async function setConversationState(
  ctx: Ctx,
  conversationId: string,
  state: ConversationState,
  options: { reason?: string; silent?: boolean } = {},
): Promise<void> {
  const { conversation } = await getConversation(ctx, conversationId);
  if (conversation.state === state) return;

  const patch: Record<string, unknown> = { state, updatedAt: new Date() };
  if (isStopped(state)) {
    patch.aiEnabled = false;
    patch.aiPausedReason = options.reason ?? `state:${state}`;
    patch.nextFollowUpAt = null;
    patch.closedAt = new Date();
  }

  await getDb().update(conversations).set(patch).where(eq(conversations.id, conversationId));

  if (!options.silent) {
    await recordActivity(ctx, {
      type: 'state_changed',
      title: `Conversation ${conversation.state} → ${state}`,
      body: options.reason ?? null,
      contactId: conversation.contactId,
      conversationId,
      metadata: { from: conversation.state, to: state },
    });
  }
}

export async function setAiEnabled(
  ctx: Ctx,
  conversationId: string,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  assertCan(ctx.role, 'conversation:write');
  const { conversation } = await getConversation(ctx, conversationId);

  await getDb()
    .update(conversations)
    .set({
      aiEnabled: enabled,
      aiPausedReason: enabled ? null : (reason ?? 'paused by operator'),
      requiresHuman: enabled ? false : conversation.requiresHuman,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  await recordActivity(ctx, {
    type: 'note',
    title: enabled ? 'AI resumed' : 'AI paused',
    body: reason ?? null,
    contactId: conversation.contactId,
    conversationId,
  });
}

/**
 * Hands the conversation to a human: stops automated replies, flags it, and
 * notifies the team. Called by the agent and by deterministic signal detection.
 */
export async function triggerHandoff(
  ctx: Ctx,
  conversationId: string,
  reason: string,
): Promise<void> {
  const { conversation, contact } = await getConversation(ctx, conversationId);
  if (conversation.requiresHuman && conversation.handoffReason === reason) return;

  await getDb()
    .update(conversations)
    .set({
      requiresHuman: true,
      handoffReason: reason,
      aiEnabled: false,
      aiPausedReason: `handoff: ${reason}`,
      state: isStopped(conversation.state) ? conversation.state : 'HUMAN_HANDOFF',
      nextFollowUpAt: null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  await recordActivity(ctx, {
    type: 'human_handoff',
    title: 'Handed to a human',
    body: reason,
    contactId: conversation.contactId,
    conversationId,
    metadata: { reason },
  });

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phone;
  await notify(ctx, {
    type: 'human_handoff',
    title: `${name} needs a human`,
    body: reason,
    link: `/inbox/${conversationId}`,
  });
}

export async function takeOverConversation(ctx: Ctx, conversationId: string): Promise<void> {
  assertCan(ctx.role, 'conversation:write');
  const { conversation } = await getConversation(ctx, conversationId);

  await getDb()
    .update(conversations)
    .set({
      assignedUserId: ctx.userId,
      aiEnabled: false,
      aiPausedReason: 'human took over',
      requiresHuman: false,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  await recordActivity(ctx, {
    type: 'note',
    title: 'Conversation taken over',
    contactId: conversation.contactId,
    conversationId,
  });
}

export async function assignConversation(
  ctx: Ctx,
  conversationId: string,
  userId: string | null,
): Promise<void> {
  assertCan(ctx.role, 'conversation:write');
  await getDb()
    .update(conversations)
    .set({ assignedUserId: userId, updatedAt: new Date() })
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.organizationId, ctx.organizationId)),
    );
}

export async function markRead(ctx: Ctx, conversationId: string): Promise<void> {
  await getDb()
    .update(conversations)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.organizationId, ctx.organizationId)),
    );
}

export async function setLeadTemperature(
  ctx: Ctx,
  conversationId: string,
  temperature: LeadTemperature,
): Promise<void> {
  await getDb()
    .update(conversations)
    .set({ leadTemperature: temperature, updatedAt: new Date() })
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.organizationId, ctx.organizationId)),
    );
}

export async function countNeedingHuman(ctx: Ctx): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.requiresHuman, true)),
    );
  return rows[0]?.count ?? 0;
}

/** Conversations whose scheduled AI follow-up is due. Drained by the worker. */
export async function dueFollowUps(limit = 50) {
  return getDb()
    .select({
      id: conversations.id,
      organizationId: conversations.organizationId,
      contactId: conversations.contactId,
    })
    .from(conversations)
    .where(
      and(
        isNotNull(conversations.nextFollowUpAt),
        lte(conversations.nextFollowUpAt, new Date()),
        eq(conversations.aiEnabled, true),
        eq(conversations.requiresHuman, false),
        ne(conversations.state, 'DO_NOT_CONTACT'),
      ),
    )
    .limit(limit);
}
