import { getDb } from '@/lib/db';
import { aiSummaries } from '@/lib/db/schema';
import { getConversation } from '@/lib/services/conversations';
import { listMessages } from '@/lib/services/messages';
import { describeQualification, getQualification, parseFields } from '@/lib/services/qualification';
import type { Ctx } from '@/lib/auth/context';
import { resolvePrompt } from './prompts';
import { runAgent } from './runner';
import { summarySchema, type SummaryOutput } from './schemas';

export type SummaryOutcome =
  | { result: 'summarized'; output: SummaryOutput; id: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; error: string };

/**
 * Produces the handoff brief a human reads before taking over.
 *
 * Written to `ai_summaries` rather than replacing the previous one, so the
 * record of what the rep was told at each handoff survives.
 */
export async function summarizeConversation(
  ctx: Ctx,
  conversationId: string,
): Promise<SummaryOutcome> {
  const { conversation, contact, company } = await getConversation(ctx, conversationId);
  const transcript = await listMessages(ctx, conversationId);

  if (transcript.filter((m) => m.direction === 'INBOUND').length === 0) {
    return { result: 'skipped', reason: 'the prospect has not replied yet' };
  }

  const qualification = await getQualification(ctx, conversationId);
  const prompt = await resolvePrompt(ctx, 'summary');

  const context = [
    `Company: ${company?.name ?? 'unknown'}`,
    `Contact: ${[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phone}`,
    `City: ${company?.city ?? 'unknown'}`,
    `Conversation state: ${conversation.state}`,
    '',
    'Qualification captured so far:',
    describeQualification(parseFields(qualification?.fields)),
    '',
    'Transcript (P = prospect, U = us):',
    transcript.map((m) => `${m.direction === 'INBOUND' ? 'P' : 'U'}: ${m.body}`).join('\n'),
  ].join('\n');

  const result = await runAgent(ctx, {
    agentType: 'summary',
    schema: summarySchema,
    system: prompt.prompt,
    promptVersion: prompt.version,
    messages: [{ role: 'user', content: context }],
    tier: 'smart',
    maxTokens: 800,
    temperature: 0.3,
    conversationId,
    contactId: contact.id,
  });

  if (!result.ok) return { result: 'failed', error: result.error };

  const output = result.output;
  const [row] = await getDb()
    .insert(aiSummaries)
    .values({
      organizationId: ctx.organizationId,
      conversationId,
      summary: output.summary,
      painIdentified: output.pain_identified,
      currentProcess: output.current_process,
      objections: output.objections,
      opportunity: output.opportunity,
      recommendedNextStep: output.recommended_next_step,
      leadTemperature: output.lead_temperature,
      messageCountAtSummary: transcript.length,
    })
    .returning();

  return { result: 'summarized', output, id: row!.id };
}
