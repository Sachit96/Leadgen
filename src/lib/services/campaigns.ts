import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { outer } from '@/lib/db/sql';
import { getDb } from '@/lib/db';
import {
  campaignMemberships,
  campaignSteps,
  campaignVariants,
  campaigns,
  contacts,
  conversations,
  messages,
} from '@/lib/db/schema';
import { invalid, notFound } from '@/lib/core/errors';
import { extractVariables } from '@/lib/core/template';
import { KNOWN_TEMPLATE_VARIABLES } from '@/lib/constants/enums';
import { assertCan } from '@/lib/auth/rbac';
import { recordActivity } from './activity';
import { listProspectIds, type ProspectFilters } from './contacts';
import { suppressedSet } from './suppression';
import type { Ctx } from '@/lib/auth/context';
import type { Campaign, CampaignStatus, CampaignStep, CampaignVariant } from '@/lib/db/types';

export type CampaignInput = {
  name: string;
  description?: string | null;
  industry?: string | null;
  dailyCapacity?: number;
  sendingWindowStart?: string;
  sendingWindowEnd?: string;
  sendingDays?: number[];
  timezone?: string;
  messageStrategy?: string | null;
  fromPhoneNumberId?: string | null;
  minScore?: number | null;
  audience?: Record<string, unknown>;
};

export async function listCampaigns(ctx: Ctx) {
  const db = getDb();
  return db
    .select({
      campaign: campaigns,
      prospects: sql<number>`(
        select count(*)::int from ${campaignMemberships} cm
        where cm.campaign_id = ${outer(campaigns.id)} and cm.status <> 'STOPPED'
      )`,
      sent: sql<number>`(
        select count(*)::int from ${messages} m
        where m.campaign_id = ${outer(campaigns.id)} and m.direction = 'OUTBOUND'
          and m.status in ('SENT','DELIVERED')
      )`,
      replies: sql<number>`(
        select count(*)::int from ${messages} m
        where m.campaign_id = ${outer(campaigns.id)} and m.direction = 'INBOUND'
      )`,
    })
    .from(campaigns)
    .where(eq(campaigns.organizationId, ctx.organizationId))
    .orderBy(desc(campaigns.createdAt));
}

export async function getCampaign(ctx: Ctx, id: string): Promise<Campaign> {
  const rows = await getDb()
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Campaign');
  return row;
}

export type CampaignSequence = Array<CampaignStep & { variants: CampaignVariant[] }>;

export async function getCampaignSequence(ctx: Ctx, campaignId: string): Promise<CampaignSequence> {
  const db = getDb();
  const steps = await db
    .select()
    .from(campaignSteps)
    .where(
      and(eq(campaignSteps.organizationId, ctx.organizationId), eq(campaignSteps.campaignId, campaignId)),
    )
    .orderBy(asc(campaignSteps.position));

  if (steps.length === 0) return [];

  const variants = await db
    .select()
    .from(campaignVariants)
    .where(
      and(
        eq(campaignVariants.organizationId, ctx.organizationId),
        inArray(
          campaignVariants.stepId,
          steps.map((s) => s.id),
        ),
      ),
    )
    .orderBy(asc(campaignVariants.name));

  return steps.map((step) => ({ ...step, variants: variants.filter((v) => v.stepId === step.id) }));
}

export async function createCampaign(ctx: Ctx, input: CampaignInput): Promise<Campaign> {
  assertCan(ctx.role, 'campaign:write');
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      organizationId: ctx.organizationId,
      name: input.name.trim(),
      description: input.description ?? null,
      industry: input.industry ?? null,
      dailyCapacity: input.dailyCapacity ?? 50,
      sendingWindowStart: input.sendingWindowStart ?? '09:00',
      sendingWindowEnd: input.sendingWindowEnd ?? '19:00',
      sendingDays: input.sendingDays ?? [1, 2, 3, 4, 5],
      timezone: input.timezone ?? ctx.timezone,
      messageStrategy: input.messageStrategy ?? null,
      fromPhoneNumberId: input.fromPhoneNumberId ?? null,
      minScore: input.minScore ?? null,
      audience: input.audience ?? {},
    })
    .returning();
  return row!;
}

export async function updateCampaign(
  ctx: Ctx,
  id: string,
  input: Partial<CampaignInput>,
): Promise<Campaign> {
  assertCan(ctx.role, 'campaign:write');
  await getCampaign(ctx, id);
  const [row] = await getDb()
    .update(campaigns)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .returning();
  return row!;
}

/**
 * Activating a campaign is gated on it being able to actually send: a campaign
 * with no step, or a step with no variant, would silently do nothing.
 */
export async function setCampaignStatus(
  ctx: Ctx,
  id: string,
  status: CampaignStatus,
): Promise<Campaign> {
  assertCan(ctx.role, status === 'ACTIVE' ? 'campaign:launch' : 'campaign:write');
  const campaign = await getCampaign(ctx, id);

  if (status === 'ACTIVE') {
    const sequence = await getCampaignSequence(ctx, id);
    const active = sequence.filter((s) => s.active);
    if (active.length === 0) throw invalid('Add at least one step before activating this campaign');
    const first = active[0]!;
    if (!first.useAi && first.variants.filter((v) => v.active).length === 0) {
      throw invalid(`Step "${first.name}" has no active message variant`);
    }
  }

  const [row] = await getDb()
    .update(campaigns)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .returning();

  // Resuming makes pending members due immediately; pausing leaves them where
  // they are so nothing is lost.
  if (status === 'ACTIVE') {
    await getDb()
      .update(campaignMemberships)
      .set({ status: 'ACTIVE', nextStepAt: sql`coalesce(${campaignMemberships.nextStepAt}, now())` })
      .where(
        and(eq(campaignMemberships.campaignId, id), eq(campaignMemberships.status, 'PENDING')),
      );
  }

  await recordActivity(ctx, {
    type: 'note',
    title: `Campaign "${campaign.name}" set to ${status}`,
    campaignId: id,
  });

  return row!;
}

/* --------------------------------------------------------------- steps */

export type StepInput = {
  name: string;
  delayHours?: number;
  useAi?: boolean;
  conditions?: string[];
  stopConditions?: string[];
  active?: boolean;
};

export async function createStep(ctx: Ctx, campaignId: string, input: StepInput): Promise<CampaignStep> {
  assertCan(ctx.role, 'campaign:write');
  await getCampaign(ctx, campaignId);

  const existing = await getDb()
    .select({ position: campaignSteps.position })
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, campaignId))
    .orderBy(desc(campaignSteps.position))
    .limit(1);

  const [row] = await getDb()
    .insert(campaignSteps)
    .values({
      organizationId: ctx.organizationId,
      campaignId,
      position: (existing[0]?.position ?? 0) + 1,
      name: input.name.trim(),
      delayHours: input.delayHours ?? 48,
      useAi: input.useAi ?? false,
      conditions: input.conditions ?? [],
      stopConditions: input.stopConditions ?? ['replied'],
      active: input.active ?? true,
    })
    .returning();
  return row!;
}

export async function updateStep(ctx: Ctx, stepId: string, input: Partial<StepInput>): Promise<void> {
  assertCan(ctx.role, 'campaign:write');
  await getDb()
    .update(campaignSteps)
    .set(input)
    .where(and(eq(campaignSteps.id, stepId), eq(campaignSteps.organizationId, ctx.organizationId)));
}

export async function deleteStep(ctx: Ctx, stepId: string): Promise<void> {
  assertCan(ctx.role, 'campaign:write');
  await getDb()
    .delete(campaignSteps)
    .where(and(eq(campaignSteps.id, stepId), eq(campaignSteps.organizationId, ctx.organizationId)));
}

export async function reorderSteps(ctx: Ctx, campaignId: string, stepIds: string[]): Promise<void> {
  assertCan(ctx.role, 'campaign:write');
  const db = getDb();
  // Two passes: park positions out of range first so the unique
  // (campaign_id, position) index cannot collide mid-reorder.
  for (const [index, stepId] of stepIds.entries()) {
    await db
      .update(campaignSteps)
      .set({ position: -(index + 1) })
      .where(and(eq(campaignSteps.id, stepId), eq(campaignSteps.campaignId, campaignId)));
  }
  for (const [index, stepId] of stepIds.entries()) {
    await db
      .update(campaignSteps)
      .set({ position: index + 1 })
      .where(and(eq(campaignSteps.id, stepId), eq(campaignSteps.campaignId, campaignId)));
  }
}

/* ------------------------------------------------------------ variants */

export type VariantInput = {
  name: string;
  angle?: string;
  template: string;
  weight?: number;
  active?: boolean;
};

export { MESSAGE_ANGLES } from '@/lib/constants/enums';

export async function createVariant(
  ctx: Ctx,
  campaignId: string,
  stepId: string,
  input: VariantInput,
): Promise<CampaignVariant> {
  assertCan(ctx.role, 'campaign:write');
  validateTemplate(input.template);
  const [row] = await getDb()
    .insert(campaignVariants)
    .values({
      organizationId: ctx.organizationId,
      campaignId,
      stepId,
      name: input.name.trim(),
      angle: input.angle ?? 'curiosity',
      template: input.template.trim(),
      weight: input.weight ?? 1,
      active: input.active ?? true,
    })
    .returning();
  return row!;
}

export async function updateVariant(
  ctx: Ctx,
  variantId: string,
  input: Partial<VariantInput>,
): Promise<void> {
  assertCan(ctx.role, 'campaign:write');
  if (input.template) validateTemplate(input.template);
  await getDb()
    .update(campaignVariants)
    .set(input)
    .where(
      and(eq(campaignVariants.id, variantId), eq(campaignVariants.organizationId, ctx.organizationId)),
    );
}

export async function deleteVariant(ctx: Ctx, variantId: string): Promise<void> {
  assertCan(ctx.role, 'campaign:write');
  await getDb()
    .delete(campaignVariants)
    .where(
      and(eq(campaignVariants.id, variantId), eq(campaignVariants.organizationId, ctx.organizationId)),
    );
}


export function validateTemplate(template: string): void {
  if (!template.trim()) throw invalid('Message template cannot be empty');
  const unknown = extractVariables(template).filter((v) => !KNOWN_TEMPLATE_VARIABLES.has(v));
  if (unknown.length > 0) {
    throw invalid(
      `Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }
}

/**
 * Weighted variant selection. Deterministic given `seed`, so the same prospect
 * on the same step always lands in the same arm of an experiment.
 */
export function pickVariant(variants: CampaignVariant[], seed: string): CampaignVariant | null {
  const active = variants.filter((v) => v.active && v.weight > 0);
  if (active.length === 0) return null;

  const total = active.reduce((sum, v) => sum + v.weight, 0);
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;

  let cursor = hash % total;
  for (const variant of active) {
    if (cursor < variant.weight) return variant;
    cursor -= variant.weight;
  }
  return active[0]!;
}

/* --------------------------------------------------------- enrollment */

export type EnrollResult = {
  enrolled: number;
  skippedSuppressed: number;
  skippedAlreadyEnrolled: number;
  skippedBelowScore: number;
};

export async function enrollProspects(
  ctx: Ctx,
  campaignId: string,
  contactIds: string[],
): Promise<EnrollResult> {
  assertCan(ctx.role, 'campaign:write');
  const campaign = await getCampaign(ctx, campaignId);
  const db = getDb();

  const result: EnrollResult = {
    enrolled: 0,
    skippedSuppressed: 0,
    skippedAlreadyEnrolled: 0,
    skippedBelowScore: 0,
  };
  if (contactIds.length === 0) return result;

  const candidates = await db
    .select({ id: contacts.id, phone: contacts.phone, status: contacts.status, score: contacts.score })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, contactIds)));

  const suppressed = await suppressedSet(ctx, candidates.map((c) => c.phone));

  const existing = await db
    .select({ contactId: campaignMemberships.contactId })
    .from(campaignMemberships)
    .where(
      and(
        eq(campaignMemberships.campaignId, campaignId),
        inArray(campaignMemberships.contactId, candidates.map((c) => c.id)),
      ),
    );
  const alreadyIn = new Set(existing.map((e) => e.contactId));

  const toEnroll: string[] = [];
  for (const candidate of candidates) {
    if (alreadyIn.has(candidate.id)) {
      result.skippedAlreadyEnrolled += 1;
      continue;
    }
    if (suppressed.has(candidate.phone) || candidate.status === 'DO_NOT_CONTACT') {
      result.skippedSuppressed += 1;
      continue;
    }
    if (campaign.minScore !== null && (candidate.score ?? 0) < campaign.minScore) {
      result.skippedBelowScore += 1;
      continue;
    }
    toEnroll.push(candidate.id);
  }

  if (toEnroll.length === 0) return result;

  const active = campaign.status === 'ACTIVE';
  await db
    .insert(campaignMemberships)
    .values(
      toEnroll.map((contactId) => ({
        organizationId: ctx.organizationId,
        campaignId,
        contactId,
        status: (active ? 'ACTIVE' : 'PENDING') as 'ACTIVE' | 'PENDING',
        nextStepAt: active ? new Date() : null,
      })),
    )
    .onConflictDoNothing();

  result.enrolled = toEnroll.length;

  for (const contactId of toEnroll) {
    await recordActivity(ctx, {
      type: 'campaign_assigned',
      title: `Added to campaign "${campaign.name}"`,
      contactId,
      campaignId,
    });
  }

  await db
    .update(contacts)
    .set({ status: 'QUEUED', updatedAt: new Date() })
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        inArray(contacts.id, toEnroll),
        sql`${contacts.status} in ('NEW','RESEARCHING','READY')`,
      ),
    );

  return result;
}

export async function enrollByFilter(
  ctx: Ctx,
  campaignId: string,
  filters: ProspectFilters,
  limit = 5000,
): Promise<EnrollResult> {
  const ids = await listProspectIds(ctx, filters, limit);
  return enrollProspects(ctx, campaignId, ids);
}

export async function removeFromCampaign(
  ctx: Ctx,
  campaignId: string,
  contactIds: string[],
): Promise<number> {
  assertCan(ctx.role, 'campaign:write');
  if (contactIds.length === 0) return 0;
  const removed = await getDb()
    .update(campaignMemberships)
    .set({ status: 'STOPPED', nextStepAt: null, stoppedReason: 'removed by operator' })
    .where(
      and(
        eq(campaignMemberships.campaignId, campaignId),
        eq(campaignMemberships.organizationId, ctx.organizationId),
        inArray(campaignMemberships.contactId, contactIds),
      ),
    )
    .returning({ id: campaignMemberships.id });
  return removed.length;
}

export async function listCampaignMembers(
  ctx: Ctx,
  campaignId: string,
  limit = 100,
  offset = 0,
) {
  return getDb()
    .select({
      membership: campaignMemberships,
      contact: contacts,
      conversationId: conversations.id,
    })
    .from(campaignMemberships)
    .innerJoin(contacts, eq(contacts.id, campaignMemberships.contactId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(
      and(
        eq(campaignMemberships.organizationId, ctx.organizationId),
        eq(campaignMemberships.campaignId, campaignId),
      ),
    )
    .orderBy(desc(campaignMemberships.addedAt))
    .limit(limit)
    .offset(offset);
}
