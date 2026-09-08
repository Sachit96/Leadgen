import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { orgSettings } from '@/lib/db/schema';
import { DEFAULT_SCORING_CONFIG, parseScoringConfig, type ScoringConfig } from '@/lib/core/scoring';
import type { Ctx } from '@/lib/auth/context';
import { assertCan } from '@/lib/auth/rbac';

/**
 * Org settings are the seam that keeps the product configurable rather than
 * hardcoded — the offer, the scoring weights, the sending guardrails and the AI
 * behaviour are all data an operator can edit.
 */
export const offerSchema = z.object({
  productName: z.string().default('On Radar Booked Jobs System'),
  companyName: z.string().default('On Radar'),
  setupCents: z.number().int().min(0).default(50_000),
  monthlyCents: z.number().int().min(0).default(20_000),
  currency: z.string().default('CAD'),
  guarantee: z.string().default(''),
  oneLiner: z
    .string()
    .default('We help contractors recover revenue from leads and estimates that went cold.'),
  /** Blank means "the AI must not state a contract length". */
  contractTerms: z.string().default(''),
});

export const sendingSchema = z.object({
  /** Hard ceiling across every campaign in the org, per day. */
  dailyOrgCap: z.number().int().min(0).default(500),
  /** Minimum gap between two automated messages to the same contact. */
  contactCooldownMinutes: z.number().int().min(0).default(60),
  maxAutomatedPerContactPerDay: z.number().int().min(1).default(2),
  /** Local-time window outside which nothing automated is sent. */
  quietHoursStart: z.string().default('21:00'),
  quietHoursEnd: z.string().default('09:00'),
  sendingDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  /** Appended to the first message of a sequence. */
  optOutFooter: z.string().default('Reply STOP to opt out.'),
  includeOptOutFooter: z.boolean().default(true),
});

export const aiSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoReply: z.boolean().default(true),
  /** Below this, the AI hands the conversation to a human instead of replying. */
  handoffConfidenceThreshold: z.number().min(0).max(1).default(0.55),
  /** Safety valve: after this many AI turns without progress, escalate. */
  maxAiTurnsPerConversation: z.number().int().min(1).default(12),
  agentName: z.string().default('On Radar SDR'),
  /** Whether the agent must disclose it is an assistant when asked. */
  discloseAiWhenAsked: z.boolean().default(true),
  /** Human review before the very first outbound of any sequence. */
  requireApprovalForFirstMessage: z.boolean().default(false),
});

export type OfferSettings = z.infer<typeof offerSchema>;
export type SendingSettings = z.infer<typeof sendingSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export type OrgConfig = {
  offer: OfferSettings;
  sending: SendingSettings;
  ai: AiSettings;
  scoring: ScoringConfig;
};

export const DEFAULT_ORG_CONFIG: OrgConfig = {
  offer: offerSchema.parse({}),
  sending: sendingSchema.parse({}),
  ai: aiSettingsSchema.parse({}),
  scoring: DEFAULT_SCORING_CONFIG,
};

export async function getOrgConfig(ctx: Ctx): Promise<OrgConfig> {
  const rows = await getDb()
    .select()
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, ctx.organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) return DEFAULT_ORG_CONFIG;

  return {
    offer: safe(offerSchema, row.offer, DEFAULT_ORG_CONFIG.offer),
    sending: safe(sendingSchema, row.sending, DEFAULT_ORG_CONFIG.sending),
    ai: safe(aiSettingsSchema, row.ai, DEFAULT_ORG_CONFIG.ai),
    scoring: parseScoringConfig(row.scoring),
  };
}

function safe<S extends z.ZodTypeAny>(schema: S, value: unknown, fallback: z.output<S>): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  return parsed.success ? parsed.data : fallback;
}

export async function ensureOrgSettings(organizationId: string): Promise<void> {
  await getDb()
    .insert(orgSettings)
    .values({
      organizationId,
      offer: DEFAULT_ORG_CONFIG.offer,
      sending: DEFAULT_ORG_CONFIG.sending,
      ai: DEFAULT_ORG_CONFIG.ai,
      scoring: DEFAULT_ORG_CONFIG.scoring,
    })
    .onConflictDoNothing();
}

export type OrgConfigPatch = Partial<{
  offer: Partial<OfferSettings>;
  sending: Partial<SendingSettings>;
  ai: Partial<AiSettings>;
  scoring: ScoringConfig;
}>;

export async function updateOrgConfig(ctx: Ctx, patch: OrgConfigPatch): Promise<OrgConfig> {
  assertCan(ctx.role, 'settings:write');
  const current = await getOrgConfig(ctx);

  const next: OrgConfig = {
    offer: offerSchema.parse({ ...current.offer, ...(patch.offer ?? {}) }),
    sending: sendingSchema.parse({ ...current.sending, ...(patch.sending ?? {}) }),
    ai: aiSettingsSchema.parse({ ...current.ai, ...(patch.ai ?? {}) }),
    scoring: patch.scoring ? parseScoringConfig(patch.scoring) : current.scoring,
  };

  await getDb()
    .insert(orgSettings)
    .values({
      organizationId: ctx.organizationId,
      offer: next.offer,
      sending: next.sending,
      ai: next.ai,
      scoring: next.scoring,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgSettings.organizationId,
      set: {
        offer: next.offer,
        sending: next.sending,
        ai: next.ai,
        scoring: next.scoring,
        updatedAt: new Date(),
      },
    });

  return next;
}

export function formatMoney(cents: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
