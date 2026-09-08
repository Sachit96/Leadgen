import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { knowledgeEntries, objections } from '@/lib/db/schema';
import { assertCan } from '@/lib/auth/rbac';
import { formatMoney, getOrgConfig } from './settings';
import type { Ctx } from '@/lib/auth/context';
import type { KnowledgeEntry, Objection } from '@/lib/db/types';

export const KNOWLEDGE_CATEGORIES = [
  'offer',
  'pricing',
  'guarantee',
  'faq',
  'case_study',
  'service',
  'sales_rule',
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export async function listKnowledge(ctx: Ctx): Promise<KnowledgeEntry[]> {
  return getDb()
    .select()
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.organizationId, ctx.organizationId))
    .orderBy(asc(knowledgeEntries.category), asc(knowledgeEntries.position));
}

export async function createKnowledge(
  ctx: Ctx,
  input: { category: string; title: string; content: string; position?: number },
): Promise<KnowledgeEntry> {
  assertCan(ctx.role, 'ai:configure');
  const [row] = await getDb()
    .insert(knowledgeEntries)
    .values({
      organizationId: ctx.organizationId,
      category: input.category,
      title: input.title.trim(),
      content: input.content.trim(),
      position: input.position ?? 0,
    })
    .returning();
  return row!;
}

export async function updateKnowledge(
  ctx: Ctx,
  id: string,
  input: Partial<{ title: string; content: string; category: string; active: boolean; position: number }>,
): Promise<void> {
  assertCan(ctx.role, 'ai:configure');
  await getDb()
    .update(knowledgeEntries)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.organizationId, ctx.organizationId)),
    );
}

export async function deleteKnowledge(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx.role, 'ai:configure');
  await getDb()
    .delete(knowledgeEntries)
    .where(
      and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.organizationId, ctx.organizationId)),
    );
}

export async function listObjections(ctx: Ctx): Promise<Objection[]> {
  return getDb()
    .select()
    .from(objections)
    .where(eq(objections.organizationId, ctx.organizationId))
    .orderBy(asc(objections.trigger));
}

export async function createObjection(
  ctx: Ctx,
  input: { trigger: string; matchers?: string[]; strategy: string; exampleResponses?: string[] },
): Promise<Objection> {
  assertCan(ctx.role, 'ai:configure');
  const [row] = await getDb()
    .insert(objections)
    .values({
      organizationId: ctx.organizationId,
      trigger: input.trigger.trim(),
      matchers: input.matchers ?? [],
      strategy: input.strategy.trim(),
      exampleResponses: input.exampleResponses ?? [],
    })
    .returning();
  return row!;
}

export async function updateObjection(
  ctx: Ctx,
  id: string,
  input: Partial<{ trigger: string; matchers: string[]; strategy: string; exampleResponses: string[]; active: boolean }>,
): Promise<void> {
  assertCan(ctx.role, 'ai:configure');
  await getDb()
    .update(objections)
    .set(input)
    .where(and(eq(objections.id, id), eq(objections.organizationId, ctx.organizationId)));
}

export async function deleteObjection(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx.role, 'ai:configure');
  await getDb()
    .delete(objections)
    .where(and(eq(objections.id, id), eq(objections.organizationId, ctx.organizationId)));
}

/**
 * Renders the knowledge base into the block the sales agent sees.
 *
 * Pricing comes from settings rather than a knowledge row, so there is exactly
 * one place the real numbers live and the agent cannot quote a stale figure.
 */
export async function buildKnowledgeBlock(ctx: Ctx): Promise<string> {
  const [config, entries, objectionList] = await Promise.all([
    getOrgConfig(ctx),
    listKnowledge(ctx),
    listObjections(ctx),
  ]);

  const lines: string[] = [];

  lines.push('OFFER');
  lines.push(`Product: ${config.offer.productName} by ${config.offer.companyName}`);
  lines.push(`What it does: ${config.offer.oneLiner}`);
  lines.push(
    `Pricing: ${formatMoney(config.offer.setupCents, config.offer.currency)} setup, then ${formatMoney(
      config.offer.monthlyCents,
      config.offer.currency,
    )}/month.`,
  );
  if (config.offer.guarantee) lines.push(`Guarantee: ${config.offer.guarantee}`);
  else lines.push('Guarantee: none stated. Never promise or imply a guarantee.');
  if (config.offer.contractTerms) lines.push(`Contract: ${config.offer.contractTerms}`);
  else lines.push('Contract terms: not defined. Never state a contract length.');

  const active = entries.filter((e) => e.active);
  if (active.length > 0) {
    lines.push('');
    lines.push('KNOWLEDGE');
    for (const entry of active) {
      lines.push(`[${entry.category}] ${entry.title}: ${entry.content}`);
    }
  }

  const activeObjections = objectionList.filter((o) => o.active);
  if (activeObjections.length > 0) {
    lines.push('');
    lines.push('OBJECTION HANDLING — strategies, not scripts. Never repeat one verbatim twice.');
    for (const objection of activeObjections) {
      lines.push(`"${objection.trigger}" -> ${objection.strategy}`);
      const examples = Array.isArray(objection.exampleResponses)
        ? (objection.exampleResponses as string[])
        : [];
      if (examples.length > 0) lines.push(`   e.g. ${examples.slice(0, 2).join(' / ')}`);
    }
  }

  return lines.join('\n');
}
