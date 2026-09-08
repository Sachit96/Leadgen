import type { AiProvider, CompletionRequest, CompletionResult, ModelTier } from './types';

export type MockResponder = (request: CompletionRequest) => string;

/**
 * Deterministic AI provider for tests and demo mode.
 *
 * It returns schema-valid structured output for each agent, so the whole
 * conversation engine — parsing, validation, state transitions, handoff — runs
 * exactly as it does in production, without an API key.
 */
export class MockAiProvider implements AiProvider {
  readonly kind = 'mock' as const;
  readonly configured = true;

  /** Queue of scripted responses; consumed before the default responder. */
  private readonly scripted: string[] = [];
  responder: MockResponder | null = null;
  /** When set, the next call throws. Used to test AI-failure handling. */
  failNext = false;
  calls: CompletionRequest[] = [];

  modelFor(tier: ModelTier): string {
    return tier === 'fast' ? 'mock-fast' : 'mock-smart';
  }

  script(...responses: string[]): void {
    this.scripted.push(...responses);
  }

  reset(): void {
    this.scripted.length = 0;
    this.responder = null;
    this.failNext = false;
    this.calls = [];
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    if (this.failNext) {
      this.failNext = false;
      const { AiProviderError } = await import('./types');
      throw new AiProviderError('Mock AI failure', { retryable: false });
    }

    const text = this.scripted.shift() ?? this.responder?.(request) ?? defaultResponse(request);
    return {
      text,
      model: this.modelFor(request.tier),
      inputTokens: 500,
      outputTokens: 120,
      costCents: 0,
      latencyMs: 5,
    };
  }
}

function lastUserMessage(request: CompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role === 'user') return message.content;
  }
  return '';
}

/** Shapes the reply by which agent's schema the system prompt asks for. */
function defaultResponse(request: CompletionRequest): string {
  const system = request.system;
  const input = lastUserMessage(request);

  if (system.includes('AGENT: research')) {
    return JSON.stringify({
      summary: 'Established local contractor with steady review volume.',
      pain_points: ['Leads that go cold after the first follow-up attempt'],
      personalization_hook: 'You have clearly built a reputation locally',
      outreach_angle: 'old_estimates',
      confidence: 0.6,
      unknowns: ['advertising spend', 'CRM in use'],
    });
  }

  if (system.includes('AGENT: summary')) {
    return JSON.stringify({
      summary: 'Prospect engaged and described a manual follow-up process.',
      pain_identified: 'Estimates go cold after roughly a week of manual follow-up',
      current_process: 'Owner follows up by phone when time allows',
      objections: [],
      opportunity: 'Open to seeing how automated follow-up would work',
      recommended_next_step: 'Offer a 10-minute call this week',
      lead_temperature: 'warm',
    });
  }

  if (system.includes('AGENT: qualification')) {
    return JSON.stringify({ updates: {}, next_question: 'monthly_lead_volume', confidence: 0.7 });
  }

  if (system.includes('AGENT: outreach')) {
    return JSON.stringify({
      message: 'Quick question about the estimates that never closed — do you still follow up on those?',
      rationale: 'Opens with a specific, low-friction question.',
    });
  }

  // Sales agent — vary the reply enough that demo transcripts read naturally.
  const positive = /\b(yes|yeah|sure|interested|tell me more|ok)\b/i.test(input);
  const negative = /\b(not interested|no thanks|stop)\b/i.test(input);

  return JSON.stringify({
    message: positive
      ? 'Good to hear. Roughly how many estimates a month go out without closing?'
      : negative
        ? 'Understood — I appreciate you letting me know. I will leave it there.'
        : 'Got it. How are you handling follow-up on estimates right now?',
    conversation_state: positive ? 'DISCOVERY' : negative ? 'NOT_INTERESTED' : 'OPENING',
    intent: positive ? 'positive' : negative ? 'negative' : 'neutral',
    confidence: 0.85,
    lead_temperature: positive ? 'warm' : 'cold',
    next_action: positive ? 'ask_followup' : 'wait',
    qualification_updates: {},
    requires_human: false,
    handoff_reason: null,
  });
}
