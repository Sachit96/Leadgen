import type { z } from 'zod';
import { getDb } from '@/lib/db';
import { aiRuns } from '@/lib/db/schema';
import { logger } from '@/lib/core/logger';
import { AppError } from '@/lib/core/errors';
import { AiProviderError, getAiProvider, type ModelTier } from '@/lib/providers/ai';
import type { Ctx } from '@/lib/auth/context';
import type { AgentType } from '@/lib/db/types';
import { extractJson } from './schemas';

export type AgentRunInput<S extends z.ZodTypeAny> = {
  agentType: AgentType;
  schema: S;
  system: string;
  promptVersion: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tier: ModelTier;
  maxTokens?: number;
  temperature?: number;
  conversationId?: string | null;
  contactId?: string | null;
};

export type AgentRunResult<T> =
  | { ok: true; output: T; promptVersion: string; model: string; latencyMs: number }
  | { ok: false; error: string; code: 'PARSE_FAILED' | 'PROVIDER_ERROR'; promptVersion: string };

/**
 * Runs one agent turn and validates the output.
 *
 * Contract: a caller either gets schema-valid output or an explicit failure. It
 * never receives raw model text. On a parse failure we retry once with a
 * corrective instruction; a second failure is a failure, not a guess — the
 * caller escalates to a human.
 *
 * Every attempt is written to `ai_runs` with its prompt version, model, latency
 * and cost, so AI behaviour is auditable after the fact.
 */
export async function runAgent<S extends z.ZodTypeAny>(
  ctx: Ctx,
  input: AgentRunInput<S>,
): Promise<AgentRunResult<z.output<S>>> {
  const provider = getAiProvider();
  const log = logger.child({
    organizationId: ctx.organizationId,
    conversationId: input.conversationId ?? undefined,
  });

  const messages = [...input.messages];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const completion = await provider.complete({
        system: input.system,
        messages,
        tier: input.tier,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        prefill: '{',
      });

      const json = extractJson(completion.text);
      const parsed = input.schema.safeParse(json);

      if (parsed.success) {
        await logRun(ctx, input, {
          ok: true,
          model: completion.model,
          latencyMs: completion.latencyMs,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costCents: completion.costCents,
          output: parsed.data,
        });
        return {
          ok: true,
          output: parsed.data,
          promptVersion: input.promptVersion,
          model: completion.model,
          latencyMs: completion.latencyMs,
        };
      }

      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');

      await logRun(ctx, input, {
        ok: false,
        model: completion.model,
        latencyMs: completion.latencyMs,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        costCents: completion.costCents,
        errorCode: 'PARSE_FAILED',
        errorMessage: issues,
      });

      if (attempt === 2) {
        log.error('agent output failed validation twice', {
          errorCode: 'PARSE_FAILED',
          agentType: input.agentType,
        });
        return { ok: false, error: issues, code: 'PARSE_FAILED', promptVersion: input.promptVersion };
      }

      messages.push({ role: 'assistant', content: completion.text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: `That response did not match the required schema (${issues}). Reply with only a valid JSON object matching the schema exactly. No prose, no code fences.`,
      });
    } catch (error) {
      const providerError = error instanceof AiProviderError ? error : null;
      const detail = error instanceof Error ? error.message : String(error);

      await logRun(ctx, input, {
        ok: false,
        model: provider.modelFor(input.tier),
        latencyMs: null,
        errorCode: 'PROVIDER_ERROR',
        errorMessage: detail,
      });

      if (attempt === 2 || !providerError?.retryable) {
        log.error('agent provider call failed', {
          errorCode: 'PROVIDER_ERROR',
          agentType: input.agentType,
        });
        return { ok: false, error: detail, code: 'PROVIDER_ERROR', promptVersion: input.promptVersion };
      }
    }
  }

  return { ok: false, error: 'exhausted attempts', code: 'PROVIDER_ERROR', promptVersion: input.promptVersion };
}

async function logRun<S extends z.ZodTypeAny>(
  ctx: Ctx,
  input: AgentRunInput<S>,
  result: {
    ok: boolean;
    model: string;
    latencyMs: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costCents?: number | null;
    output?: unknown;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    await getDb().insert(aiRuns).values({
      organizationId: ctx.organizationId,
      conversationId: input.conversationId ?? null,
      contactId: input.contactId ?? null,
      agentType: input.agentType,
      promptVersion: input.promptVersion,
      model: result.model,
      tier: input.tier,
      ok: result.ok,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      costCents: result.costCents ?? null,
      output: (result.output ?? null) as Record<string, unknown> | null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage?.slice(0, 1000) ?? null,
    });
  } catch (error) {
    // Telemetry must never break the sales path.
    logger.warn('failed to record ai_run', {
      organizationId: ctx.organizationId,
      errorCode: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
    });
  }
}

export function unwrapOrThrow<T>(result: AgentRunResult<T>): T {
  if (result.ok) return result.output;
  throw new AppError('AI_ERROR', result.error);
}
