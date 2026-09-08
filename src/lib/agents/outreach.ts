import { render } from '@/lib/core/template';
import { buildKnowledgeBlock } from '@/lib/services/knowledge';
import { buildPersonalizationContext } from '@/lib/services/personalization';
import { getOrgConfig } from '@/lib/services/settings';
import type { Ctx } from '@/lib/auth/context';
import { resolvePrompt } from './prompts';
import { runAgent } from './runner';
import { outreachSchema } from './schemas';

export type OutreachOutcome =
  | { result: 'generated'; message: string; rationale: string; promptVersion: string }
  | { result: 'failed'; error: string };

/**
 * Generates a personalized opening message for one prospect.
 *
 * Used by AI-enabled sequence steps and by the composer's "generate" action.
 * The prompt is built strictly from verified facts, and unknowns are named
 * explicitly so the model has no room to fabricate.
 */
export async function generateOutreachMessage(
  ctx: Ctx,
  contactId: string,
  options: { angle?: string; instruction?: string; contactIdForLog?: string } = {},
): Promise<OutreachOutcome> {
  const [personalization, knowledge, config, prompt] = await Promise.all([
    buildPersonalizationContext(ctx, contactId),
    buildKnowledgeBlock(ctx),
    getOrgConfig(ctx),
    resolvePrompt(ctx, 'personalization'),
  ]);

  const system = [
    prompt.prompt,
    '',
    knowledge,
    '',
    `You are writing as ${config.ai.agentName} from ${config.offer.companyName}.`,
    options.angle ? `Opening angle to use: ${options.angle.replace(/_/g, ' ')}.` : '',
    '',
    'VERIFIED FACTS — the only things you may reference:',
    personalization.facts.length > 0
      ? personalization.facts.map((f) => `- ${f}`).join('\n')
      : '- Nothing has been researched about this business. Keep the message generic rather than inventing detail.',
    '',
    'UNKNOWN — never assert or imply these:',
    personalization.unknowns.map((u) => `- ${u}`).join('\n') || '- (nothing)',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await runAgent(ctx, {
    agentType: 'personalization',
    schema: outreachSchema,
    system,
    promptVersion: prompt.version,
    messages: [
      {
        role: 'user',
        content:
          options.instruction ??
          'Write the opening SMS for this prospect. One question, under 320 characters.',
      },
    ],
    tier: 'smart',
    maxTokens: 500,
    temperature: 0.8,
    contactId,
  });

  if (!result.ok) return { result: 'failed', error: result.error };

  // The model can still emit a token it saw in an example; resolve anything
  // left over against the real context rather than shipping braces.
  const rendered = render(result.output.message, personalization.vars);
  if (rendered.missing.length > 0) {
    return {
      result: 'failed',
      error: `Generated message referenced unavailable data: ${rendered.missing.join(', ')}`,
    };
  }

  return {
    result: 'generated',
    message: rendered.text,
    rationale: result.output.rationale,
    promptVersion: result.promptVersion,
  };
}
