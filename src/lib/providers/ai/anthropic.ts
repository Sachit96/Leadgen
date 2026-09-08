import Anthropic from '@anthropic-ai/sdk';
import {
  AiProviderError,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
  type ModelTier,
} from './types';

export type AnthropicConfig = {
  apiKey: string;
  fastModel: string;
  smartModel: string;
};

/** Published per-million-token prices, used for the cost figures in ai_runs. */
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export class AnthropicProvider implements AiProvider {
  readonly kind = 'anthropic' as const;
  readonly configured: boolean;
  private readonly client: Anthropic | null;
  private readonly config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.config = config;
    this.configured = Boolean(config.apiKey);
    this.client = this.configured ? new Anthropic({ apiKey: config.apiKey }) : null;
  }

  modelFor(tier: ModelTier): string {
    return tier === 'fast' ? this.config.fastModel : this.config.smartModel;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.client) throw new AiProviderError('Anthropic is not configured (set ANTHROPIC_API_KEY)');

    const model = this.modelFor(request.tier);
    const started = Date.now();

    const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
    if (request.prefill) messages.push({ role: 'assistant' as const, content: request.prefill });

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
        system: request.system,
        messages,
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      return {
        // The prefill is not echoed back, so reattach it to get valid JSON.
        text: request.prefill ? request.prefill + text : text,
        model,
        inputTokens,
        outputTokens,
        costCents: estimateCostCents(model, inputTokens, outputTokens),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const status = error instanceof Anthropic.APIError ? error.status : null;
      throw new AiProviderError(error instanceof Error ? error.message : String(error), {
        statusCode: status ?? null,
        retryable: status === 429 || status === 529 || (status !== null && status >= 500),
      });
    }
  }
}

export function estimateCostCents(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const price = PRICING_PER_MTOK[model];
  if (!price || inputTokens === null || outputTokens === null) return null;
  const dollars = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  return Math.round(dollars * 100);
}
