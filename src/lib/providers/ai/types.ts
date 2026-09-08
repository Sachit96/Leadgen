/**
 * The AI boundary.
 *
 * Two tiers, because cost control is a product requirement: `fast` handles
 * classification and extraction, `smart` handles live sales turns, objections
 * and research. Callers choose a tier, never a model name.
 */
export type ModelTier = 'fast' | 'smart';

export type CompletionRequest = {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tier: ModelTier;
  maxTokens?: number;
  temperature?: number;
  /** Prefill for the assistant turn — used to force JSON-only output. */
  prefill?: string;
};

export type CompletionResult = {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: number | null;
  latencyMs: number;
};

export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number | null;

  constructor(message: string, opts: { retryable?: boolean; statusCode?: number | null } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.retryable = opts.retryable ?? false;
    this.statusCode = opts.statusCode ?? null;
  }
}

export interface AiProvider {
  readonly kind: 'anthropic' | 'mock';
  readonly configured: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  modelFor(tier: ModelTier): string;
}
