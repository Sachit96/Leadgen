import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts, conversations, pipelineDeals, users } from '@/lib/db/schema';
import { notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import { recordActivity } from './activity';
import { advanceProspectStatus } from './contacts';
import type { Ctx } from '@/lib/auth/context';
import type { PipelineDeal, PipelineStage, ProspectStatus } from '@/lib/db/types';
import { PIPELINE_STAGES } from '@/lib/db/types';

export { PIPELINE_STAGES };

export const STAGE_LABELS: Record<PipelineStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUALIFIED: 'Qualified',
  APPOINTMENT: 'Appointment',
  SHOWED: 'Showed',
  OPPORTUNITY: 'Opportunity',
  PROPOSAL: 'Proposal',
  WON: 'Won',
  LOST: 'Lost',
};

const STAGE_ORDER: Record<PipelineStage, number> = Object.fromEntries(
  PIPELINE_STAGES.map((stage, index) => [stage, index]),
) as Record<PipelineStage, number>;

/**
 * The prospect status a deal stage implies.
 *
 * Creating a deal must not silently jump the prospect ahead of where the deal
 * actually is — booking a call is an APPOINTMENT, not an OPPORTUNITY.
 */
const PROSPECT_STATUS_FOR_STAGE: Record<PipelineStage, ProspectStatus> = {
  NEW: 'CONTACTED',
  CONTACTED: 'CONTACTED',
  REPLIED: 'REPLIED',
  QUALIFIED: 'QUALIFIED',
  APPOINTMENT: 'APPOINTMENT',
  SHOWED: 'APPOINTMENT',
  OPPORTUNITY: 'OPPORTUNITY',
  PROPOSAL: 'OPPORTUNITY',
  WON: 'WON',
  LOST: 'LOST',
};

export type DealRow = {
  deal: PipelineDeal;
  contactName: string | null;
  companyName: string | null;
  phone: string;
  ownerName: string | null;
  conversationId: string | null;
};

export async function listPipeline(ctx: Ctx): Promise<DealRow[]> {
  const rows = await getDb()
    .select({
      deal: pipelineDeals,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      companyName: companies.name,
      ownerName: users.name,
      conversationId: conversations.id,
    })
    .from(pipelineDeals)
    .innerJoin(contacts, eq(contacts.id, pipelineDeals.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(users, eq(users.id, pipelineDeals.ownerUserId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(eq(pipelineDeals.organizationId, ctx.organizationId))
    .orderBy(asc(pipelineDeals.position), desc(pipelineDeals.updatedAt));

  return rows.map((r) => ({
    deal: r.deal,
    contactName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
    companyName: r.companyName,
    phone: r.phone,
    ownerName: r.ownerName,
    conversationId: r.conversationId,
  }));
}

export async function getDeal(ctx: Ctx, id: string): Promise<PipelineDeal> {
  const rows = await getDb()
    .select()
    .from(pipelineDeals)
    .where(and(eq(pipelineDeals.id, id), eq(pipelineDeals.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Deal');
  return row;
}

export type CreateDealInput = {
  contactId: string;
  title?: string;
  stage?: PipelineStage;
  valueCents?: number;
  recurringValueCents?: number;
  conversationId?: string | null;
  campaignId?: string | null;
  variantId?: string | null;
  appointmentId?: string | null;
  ownerUserId?: string | null;
};

/**
 * Creates the deal that carries revenue attribution. The campaign and variant
 * are copied from the conversation that produced the prospect, so revenue can
 * be traced back to the message that started it.
 */
export async function createDeal(ctx: Ctx, input: CreateDealInput): Promise<PipelineDeal> {
  assertCan(ctx.role, 'pipeline:write');
  const db = getDb();

  const contextRows = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      companyId: contacts.companyId,
      companyName: companies.name,
      conversationId: conversations.id,
      campaignId: conversations.campaignId,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const context = contextRows[0];
  if (!context) throw notFound('Prospect');

  const variantId = input.variantId ?? (await firstOutboundVariant(input.contactId));

  const [row] = await db
    .insert(pipelineDeals)
    .values({
      organizationId: ctx.organizationId,
      contactId: input.contactId,
      companyId: context.companyId,
      conversationId: input.conversationId ?? context.conversationId,
      campaignId: input.campaignId ?? context.campaignId,
      variantId,
      appointmentId: input.appointmentId ?? null,
      title: input.title ?? `${dealSubject(context)} — opportunity`,
      stage: input.stage ?? 'QUALIFIED',
      valueCents: input.valueCents ?? 0,
      recurringValueCents: input.recurringValueCents ?? 0,
      ownerUserId: input.ownerUserId ?? ctx.user?.userId ?? null,
    })
    .returning();

  await recordActivity(ctx, {
    type: 'opportunity_created',
    title: `Opportunity created: ${row!.title}`,
    contactId: input.contactId,
    conversationId: row!.conversationId,
    campaignId: row!.campaignId,
    metadata: { dealId: row!.id },
  });

  await advanceProspectStatus(ctx, input.contactId, PROSPECT_STATUS_FOR_STAGE[row!.stage]);
  return row!;
}

function dealSubject(context: {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const person = [context.firstName, context.lastName].filter(Boolean).join(' ').trim();
  return context.companyName ?? (person || 'New prospect');
}

/** The variant of the first outbound message — the one that opened the door. */
async function firstOutboundVariant(contactId: string): Promise<string | null> {
  const { messages } = await import('@/lib/db/schema');
  const rows = await getDb()
    .select({ variantId: messages.variantId })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.direction, 'OUTBOUND')))
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return rows[0]?.variantId ?? null;
}

export async function moveDeal(
  ctx: Ctx,
  dealId: string,
  stage: PipelineStage,
  options: { position?: number; lostReason?: string } = {},
): Promise<void> {
  assertCan(ctx.role, 'pipeline:write');
  const deal = await getDeal(ctx, dealId);
  if (deal.stage === stage && options.position === undefined) return;

  await getDb()
    .update(pipelineDeals)
    .set({
      stage,
      position: options.position ?? deal.position,
      wonAt: stage === 'WON' ? (deal.wonAt ?? new Date()) : stage === 'LOST' ? null : deal.wonAt,
      lostAt: stage === 'LOST' ? (deal.lostAt ?? new Date()) : stage === 'WON' ? null : deal.lostAt,
      lostReason: stage === 'LOST' ? (options.lostReason ?? deal.lostReason) : null,
      updatedAt: new Date(),
    })
    .where(eq(pipelineDeals.id, dealId));

  await recordActivity(ctx, {
    type: stage === 'WON' ? 'deal_won' : stage === 'LOST' ? 'deal_lost' : 'stage_changed',
    title: `Deal moved ${STAGE_LABELS[deal.stage]} → ${STAGE_LABELS[stage]}`,
    body: options.lostReason ?? null,
    contactId: deal.contactId,
    conversationId: deal.conversationId,
    campaignId: deal.campaignId,
    metadata: { dealId, from: deal.stage, to: stage },
  });

  await advanceProspectStatus(ctx, deal.contactId, PROSPECT_STATUS_FOR_STAGE[stage]);
}

/**
 * Advances an existing deal for a contact, creating one if needed. Called by
 * appointment booking and the AI agent so the pipeline tracks reality without
 * anyone dragging a card.
 */
export async function moveDealForContact(
  ctx: Ctx,
  contactId: string,
  stage: PipelineStage,
  options: { appointmentId?: string | null } = {},
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(pipelineDeals)
    .where(
      and(eq(pipelineDeals.organizationId, ctx.organizationId), eq(pipelineDeals.contactId, contactId)),
    )
    .orderBy(desc(pipelineDeals.createdAt))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    await createDeal(ctx, { contactId, stage, appointmentId: options.appointmentId ?? null });
    return;
  }

  // Never drag a deal backwards automatically; a human can still do it.
  if (STAGE_ORDER[stage] <= STAGE_ORDER[existing.stage]) return;
  if (existing.stage === 'WON' || existing.stage === 'LOST') return;

  await db
    .update(pipelineDeals)
    .set({
      stage,
      appointmentId: options.appointmentId ?? existing.appointmentId,
      updatedAt: new Date(),
    })
    .where(eq(pipelineDeals.id, existing.id));

  await recordActivity(ctx, {
    type: 'stage_changed',
    title: `Deal moved ${STAGE_LABELS[existing.stage]} → ${STAGE_LABELS[stage]}`,
    contactId,
    conversationId: existing.conversationId,
    campaignId: existing.campaignId,
    metadata: { dealId: existing.id, automatic: true },
  });

  await advanceProspectStatus(ctx, contactId, PROSPECT_STATUS_FOR_STAGE[stage]);
}

export async function updateDeal(
  ctx: Ctx,
  dealId: string,
  input: Partial<{
    title: string;
    valueCents: number;
    recurringValueCents: number;
    ownerUserId: string | null;
  }>,
): Promise<void> {
  assertCan(ctx.role, 'pipeline:write');
  await getDeal(ctx, dealId);
  await getDb()
    .update(pipelineDeals)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.organizationId, ctx.organizationId)));
}

export async function deleteDeal(ctx: Ctx, dealId: string): Promise<void> {
  assertCan(ctx.role, 'pipeline:write');
  await getDb()
    .delete(pipelineDeals)
    .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.organizationId, ctx.organizationId)));
}

export async function pipelineTotals(ctx: Ctx, since?: Date) {
  const clauses = [eq(pipelineDeals.organizationId, ctx.organizationId)];
  if (since) clauses.push(gte(pipelineDeals.createdAt, since));

  const rows = await getDb()
    .select({
      stage: pipelineDeals.stage,
      count: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${pipelineDeals.valueCents}), 0)::int`,
    })
    .from(pipelineDeals)
    .where(and(...clauses))
    .groupBy(pipelineDeals.stage);

  return rows;
}
