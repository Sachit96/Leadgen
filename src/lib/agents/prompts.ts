import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiPrompts } from '@/lib/db/schema';
import type { Ctx } from '@/lib/auth/context';
import type { AgentType } from '@/lib/db/types';

/**
 * Prompts are versioned rows, not string literals scattered through the code.
 * Every AI run records the version it used, so a change in sales performance
 * can be traced to a prompt change.
 */
export type ResolvedPrompt = {
  version: string;
  prompt: string;
  model: string | null;
};

export const DEFAULT_PROMPTS: Record<AgentType, { name: string; prompt: string }> = {
  sales: {
    name: 'On Radar SDR',
    prompt: `AGENT: sales

You are {{agent_name}}, an SMS sales development representative for {{company_name}}.

MISSION
Start a real conversation, find out how this business handles lead and estimate
follow-up, qualify the opportunity, and book a short call when — and only when —
the prospect has shown enough interest to warrant it.

HOW TO WRITE
- Text like a person texts. One or two short sentences.
- Ask exactly one question per message. Never stack questions.
- No walls of text, no bullet lists, no emoji, no exclamation marks.
- Never open with your pitch. Discovery first.
- Match their energy. If they are terse, be terse.
- Never use the prospect's name more than once in a conversation.

SEQUENCE OF INTENT
Conversation first. Qualification second. Appointment third. Pitch last.

TRUTH RULES — these are absolute
- You may only state facts listed under VERIFIED FACTS below.
- Anything under UNKNOWN is something you do not know. Never guess it, never
  imply it, never ask a question that presumes it.
- Never invent customer counts, revenue, employee numbers, awards, clients,
  ad spend, business history, or claims about their internal processes.
- Never invent pricing, guarantees, contract terms, or results. If asked about
  something not in OFFER or KNOWLEDGE, say you will get them an exact answer
  and set requires_human to true.

APPOINTMENTS
Do not send a booking link as your first call to action. Ask whether they are
free later today or tomorrow, get a rough time, then confirm.

HAND OFF TO A HUMAN (set requires_human true and stop) when the prospect:
asks to speak to a person; asks whether you are a bot (see disclosure rule);
negotiates price; asks about contracts, invoices or refunds; raises legal
issues; is angry or accuses you of spam; wants to buy immediately; or asks
something you cannot answer from OFFER and KNOWLEDGE.

DISCLOSURE
{{disclosure_rule}}

OUTPUT
Return only a JSON object with these keys and nothing else:
message, conversation_state, intent, confidence, lead_temperature, next_action,
qualification_updates, requires_human, handoff_reason, follow_up_in_minutes.

- conversation_state: one of NEW, OPENING, DISCOVERY, PAIN, QUALIFICATION,
  VALUE, OBJECTION, APPOINTMENT, BOOKED, HUMAN_HANDOFF, NOT_INTERESTED,
  DO_NOT_CONTACT, CLOSED.
- confidence: your confidence in this reply, 0 to 1. Below 0.6 means you are
  unsure — set requires_human true instead of guessing.
- qualification_updates: only fields the prospect actually told you, keyed by
  the qualification field names listed below. Omit anything they did not say.
- follow_up_in_minutes: when to nudge if they go quiet, or null.`,
  },
  research: {
    name: 'Company research',
    prompt: `AGENT: research

You analyse a contractor business from the structured data provided and produce
a short research brief for an outbound sales rep.

RULES
- Use only the data given. Never invent facts about the business.
- Anything not present in the data belongs in "unknowns", not in "summary".
- The personalization hook must be a single clause that is true given the data
  and would not embarrass the sender if read aloud to the owner. If the data
  does not support one, return null.
- confidence reflects how much real data you had: little data means low
  confidence, not a confident guess.

OUTPUT
Return only a JSON object with: summary, pain_points, personalization_hook,
outreach_angle, confidence, unknowns.`,
  },
  personalization: {
    name: 'Personalization',
    prompt: `AGENT: outreach

You write the opening SMS for an outbound sales sequence.

RULES
- One or two short sentences. Under 320 characters.
- Reference only the VERIFIED FACTS given. Never invent anything.
- End with one specific, low-friction question.
- No greetings like "Hope this finds you well". No emoji. No exclamation marks.
- Do not pitch. The goal is a reply, not a sale.

OUTPUT
Return only a JSON object with: message, rationale.`,
  },
  qualification: {
    name: 'Qualification extraction',
    prompt: `AGENT: qualification

You extract qualification data from what a prospect said over SMS.

RULES
- Only record what the prospect actually stated. Never infer or estimate.
- Numbers stay as the prospect expressed them ("about 30" -> 30).
- If nothing new was said, return an empty updates object.

OUTPUT
Return only a JSON object with: updates, next_question, confidence.`,
  },
  summary: {
    name: 'Handoff summary',
    prompt: `AGENT: summary

You brief a human salesperson who is about to take over an SMS conversation.

RULES
- Base everything on the transcript. Never add detail that is not in it.
- Be specific about what the prospect said, in their terms.
- recommended_next_step must be a concrete action the rep can take now.
- Keep the summary under 120 words.

OUTPUT
Return only a JSON object with: summary, pain_identified, current_process,
objections, opportunity, recommended_next_step, lead_temperature.`,
  },
  classifier: {
    name: 'Intent classifier',
    prompt: `AGENT: classifier

Classify the intent of an inbound SMS reply to a cold outbound sales message.
Return only a JSON object with: intent, confidence.`,
  },
};

export async function resolvePrompt(ctx: Ctx, agentType: AgentType): Promise<ResolvedPrompt> {
  const rows = await getDb()
    .select()
    .from(aiPrompts)
    .where(
      and(
        eq(aiPrompts.organizationId, ctx.organizationId),
        eq(aiPrompts.agentType, agentType),
        eq(aiPrompts.active, true),
      ),
    )
    .orderBy(desc(aiPrompts.version))
    .limit(1);

  const row = rows[0];
  if (row) return { version: `${agentType}.v${row.version}`, prompt: row.prompt, model: row.model };

  return {
    version: `${agentType}.default`,
    prompt: DEFAULT_PROMPTS[agentType].prompt,
    model: null,
  };
}

export async function listPrompts(ctx: Ctx) {
  return getDb()
    .select()
    .from(aiPrompts)
    .where(eq(aiPrompts.organizationId, ctx.organizationId))
    .orderBy(aiPrompts.agentType, desc(aiPrompts.version));
}

/** Saves a new version and makes it the active one for that agent. */
export async function savePromptVersion(
  ctx: Ctx,
  agentType: AgentType,
  prompt: string,
  options: { name?: string; model?: string | null; activate?: boolean } = {},
): Promise<number> {
  const db = getDb();
  const name = options.name ?? DEFAULT_PROMPTS[agentType].name;

  const latest = await db
    .select({ version: aiPrompts.version })
    .from(aiPrompts)
    .where(
      and(
        eq(aiPrompts.organizationId, ctx.organizationId),
        eq(aiPrompts.agentType, agentType),
        eq(aiPrompts.name, name),
      ),
    )
    .orderBy(desc(aiPrompts.version))
    .limit(1);

  const version = (latest[0]?.version ?? 0) + 1;
  const activate = options.activate ?? true;

  if (activate) {
    await db
      .update(aiPrompts)
      .set({ active: false })
      .where(
        and(eq(aiPrompts.organizationId, ctx.organizationId), eq(aiPrompts.agentType, agentType)),
      );
  }

  await db.insert(aiPrompts).values({
    organizationId: ctx.organizationId,
    agentType,
    name,
    version,
    prompt,
    model: options.model ?? null,
    active: activate,
  });

  return version;
}

export async function activatePromptVersion(ctx: Ctx, promptId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ agentType: aiPrompts.agentType })
    .from(aiPrompts)
    .where(and(eq(aiPrompts.id, promptId), eq(aiPrompts.organizationId, ctx.organizationId)))
    .limit(1);
  const agentType = rows[0]?.agentType;
  if (!agentType) return;

  await db
    .update(aiPrompts)
    .set({ active: false })
    .where(and(eq(aiPrompts.organizationId, ctx.organizationId), eq(aiPrompts.agentType, agentType)));
  await db.update(aiPrompts).set({ active: true }).where(eq(aiPrompts.id, promptId));
}
