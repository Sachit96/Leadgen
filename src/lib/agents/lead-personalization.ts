import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { companies, contacts, leadPersonalization, leadSignals } from '@/lib/db/schema';
import { getOrgConfig } from '@/lib/services/settings';
import { buildPersonalizationContext } from '@/lib/services/personalization';
import type { Ctx } from '@/lib/auth/context';
import { runAgent } from './runner';

/**
 * Generates the opening line for a lead, for both SMS and the call screen.
 *
 * Built strictly from verified facts plus explicitly named unknowns, so there
 * is nothing for the model to fabricate from. The call opener is separate from
 * the SMS opener because the two channels do not sound alike — a text can be
 * abrupt, a cold call has to identify the caller first.
 */
export const leadPersonalizationSchema = z.object({
  hook: z.string().min(1).max(200),
  recommended_angle: z.enum([
    'lost_leads',
    'old_estimates',
    'speed_to_lead',
    'follow_up',
    'curiosity',
    'direct_offer',
  ]),
  opening_message: z.string().min(1).max(400),
  call_opener: z.string().min(1).max(400),
  rationale: z.string().max(300).default(''),
  confidence: z.number().min(0).max(1),
});

export type LeadPersonalization = z.infer<typeof leadPersonalizationSchema>;

const SYSTEM_PROMPT = `AGENT: lead_personalization

You write the first line of contact for one business — one for SMS, one for a
cold call.

TRUTH RULES
- Reference only the VERIFIED FACTS given. Never invent a detail.
- The UNKNOWN list is what we do not know. Never assert or imply any of it.
- Never claim they are running ads, using a CRM, or missing a booking system
  unless it appears under VERIFIED FACTS.

SMS OPENING
- One or two short sentences, under 320 characters.
- End with one specific, low-friction question.
- No greetings like "Hope this finds you well". No emoji. No exclamation marks.
- Do not pitch. The goal is a reply.

CALL OPENING
- The rep is calling a stranger who is probably busy and on a job site.
- Identify who is calling, then ask one short question.
- Under 40 words. Written to be said out loud, not read.
- No script blocks, no monologue.

ANGLE
Pick the angle the evidence supports: lost_leads, old_estimates,
speed_to_lead, follow_up, curiosity, or direct_offer.

OUTPUT
Return only a JSON object with: hook, recommended_angle, opening_message,
call_opener, rationale, confidence.`;

export type PersonalizationOutcome =
  | { result: 'generated'; output: LeadPersonalization; id: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; error: string; retryable: boolean };

export async function generateLeadPersonalization(
  ctx: Ctx,
  contactId: string,
  options: { campaignId?: string | null; force?: boolean } = {},
): Promise<PersonalizationOutcome> {
  const db = getDb();

  const rows = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { result: 'skipped', reason: 'contact no longer exists' };
  if (!row.company) return { result: 'skipped', reason: 'no company to personalize from' };

  if (!options.force) {
    const existing = await db
      .select({ id: leadPersonalization.id })
      .from(leadPersonalization)
      .where(eq(leadPersonalization.contactId, contactId))
      .orderBy(desc(leadPersonalization.createdAt))
      .limit(1);
    if (existing[0]) return { result: 'skipped', reason: 'already personalized' };
  }

  const [context, config, signals] = await Promise.all([
    buildPersonalizationContext(ctx, contactId),
    getOrgConfig(ctx),
    db.select().from(leadSignals).where(eq(leadSignals.companyId, row.company.id)),
  ]);

  const detected = signals.filter((s) => s.detected && s.category !== 'quality');
  const facts = [
    ...context.facts,
    ...detected.map((s) => `Detected on their website: ${s.value ?? s.key}`),
    row.company.websiteQualityScore !== null
      ? `Their website scored ${row.company.websiteQualityScore}/100 on conversion basics.`
      : null,
  ].filter(Boolean) as string[];

  const userMessage = [
    `You are writing as ${config.ai.agentName} from ${config.offer.companyName}.`,
    `What ${config.offer.companyName} does: ${config.offer.oneLiner}`,
    '',
    'VERIFIED FACTS — the only things you may reference:',
    facts.length > 0 ? facts.map((f) => `- ${f}`).join('\n') : '- Nothing has been researched yet.',
    '',
    'UNKNOWN — never assert or imply these:',
    context.unknowns.length > 0 ? context.unknowns.map((u) => `- ${u}`).join('\n') : '- (nothing)',
    '',
    'Write the SMS opening and the call opening for this business.',
  ].join('\n');

  const result = await runAgent(ctx, {
    agentType: 'personalization',
    schema: leadPersonalizationSchema,
    system: SYSTEM_PROMPT,
    promptVersion: 'lead_personalization.v1',
    messages: [{ role: 'user', content: userMessage }],
    tier: 'smart',
    maxTokens: 700,
    temperature: 0.8,
    contactId,
  });

  if (!result.ok) {
    return { result: 'failed', error: result.error, retryable: result.code === 'PROVIDER_ERROR' };
  }

  const output = result.output;
  const [saved] = await db
    .insert(leadPersonalization)
    .values({
      organizationId: ctx.organizationId,
      contactId,
      campaignId: options.campaignId ?? null,
      hook: output.hook,
      recommendedAngle: output.recommended_angle,
      openingMessage: output.opening_message,
      callOpener: output.call_opener,
      confidence: output.confidence,
      promptVersion: result.promptVersion,
      approvalStatus: 'READY_FOR_REVIEW',
    })
    .returning();

  // The hook feeds {{personalization_hook}} in campaign templates.
  await db
    .update(companies)
    .set({ personalizationHooks: [output.hook], updatedAt: new Date() })
    .where(eq(companies.id, row.company.id));

  return { result: 'generated', output, id: saved!.id };
}

export async function latestPersonalization(ctx: Ctx, contactId: string) {
  const rows = await getDb()
    .select()
    .from(leadPersonalization)
    .where(
      and(
        eq(leadPersonalization.organizationId, ctx.organizationId),
        eq(leadPersonalization.contactId, contactId),
      ),
    )
    .orderBy(desc(leadPersonalization.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
