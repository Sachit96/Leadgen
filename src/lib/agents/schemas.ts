import { z } from 'zod';
import { CONVERSATION_STATES } from '@/lib/db/types';

/**
 * Every AI turn returns structured data, never free-form prose.
 *
 * If output does not parse against these schemas it is not sent — the caller
 * retries once and then hands the conversation to a human. A model is never
 * allowed to put unvalidated text in front of a prospect.
 */
export const conversationStateSchema = z.enum(CONVERSATION_STATES);

export const intentSchema = z.enum([
  'positive',
  'negative',
  'neutral',
  'question',
  'opt_out',
  'wrong_number',
  'unknown',
]);

export const leadTemperatureSchema = z.enum(['cold', 'warm', 'hot']);

export const nextActionSchema = z.enum([
  'ask_followup',
  'answer_question',
  'handle_objection',
  'qualify',
  'propose_appointment',
  'confirm_appointment',
  'wait',
  'close_conversation',
  'escalate',
]);

/** The sales agent's turn. */
export const salesTurnSchema = z.object({
  message: z.string().min(1).max(480),
  conversation_state: conversationStateSchema,
  intent: intentSchema,
  confidence: z.number().min(0).max(1),
  lead_temperature: leadTemperatureSchema,
  next_action: nextActionSchema,
  qualification_updates: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  requires_human: z.boolean().default(false),
  handoff_reason: z.string().nullable().default(null),
  /** Minutes to wait before a nudge; null means do not follow up automatically. */
  follow_up_in_minutes: z.number().int().min(5).max(20_160).nullable().default(null),
});

export type SalesTurn = z.infer<typeof salesTurnSchema>;

export const researchSchema = z.object({
  summary: z.string().min(1).max(1200),
  pain_points: z.array(z.string()).max(6).default([]),
  personalization_hook: z.string().max(200).nullable().default(null),
  outreach_angle: z.string().max(60).nullable().default(null),
  confidence: z.number().min(0).max(1),
  unknowns: z.array(z.string()).max(12).default([]),
});

export type ResearchOutput = z.infer<typeof researchSchema>;

export const summarySchema = z.object({
  summary: z.string().min(1).max(1500),
  pain_identified: z.string().nullable().default(null),
  current_process: z.string().nullable().default(null),
  objections: z.array(z.string()).max(8).default([]),
  opportunity: z.string().nullable().default(null),
  recommended_next_step: z.string().min(1),
  lead_temperature: leadTemperatureSchema,
});

export type SummaryOutput = z.infer<typeof summarySchema>;

export const outreachSchema = z.object({
  message: z.string().min(1).max(480),
  rationale: z.string().max(400).default(''),
});

export type OutreachOutput = z.infer<typeof outreachSchema>;

export const qualificationSchema = z.object({
  updates: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  next_question: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type QualificationOutput = z.infer<typeof qualificationSchema>;

/**
 * Extracts the JSON object from a model response that may be wrapped in prose
 * or a fenced code block. Returns null rather than throwing so the caller can
 * decide between a retry and a handoff.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const direct = tryParse(candidate);
  if (direct !== null) return direct;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return tryParse(candidate.slice(start, end + 1));
}

function tryParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
