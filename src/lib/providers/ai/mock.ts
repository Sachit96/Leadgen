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

  if (system.includes('AGENT: business_research')) {
    // Answers from the structured part of the prompt only. The fenced website
    // block is deliberately ignored, exactly as the real agent is told to treat
    // it — so an injection test that plants instructions in a page cannot pass
    // by accident here either.
    const name = firstMatch(input, /^Business name:\s*(.+)$/im) ?? 'This business';
    return JSON.stringify({
      business_summary: `${name} is a local service business listed in the search area.`,
      services: ['roof replacement', 'roof repair'],
      service_area: firstMatch(input, /^City:\s*(.+)$/im),
      likely_company_size: null,
      likely_customer_type: 'residential',
      growth_signals: [],
      lead_generation_signals: [],
      follow_up_risk_signals: ['No online booking found on the site'],
      personalization_hooks: ['Long-standing local presence'],
      owner_name: null,
      owner_confidence: 0,
      research_confidence: 0.4,
      unknowns: ['owner name', 'advertising spend', 'CRM in use'],
      inferred_claims: ['Residential focus inferred from listed services'],
    });
  }

  if (system.includes('AGENT: lead_personalization')) {
    const name = firstMatch(input, /The business is called (.+?)\.$/im) ?? 'your team';
    return JSON.stringify({
      hook: `${name} has a steady local presence`,
      recommended_angle: 'old_estimates',
      opening_message:
        'Quick question about the estimates that never closed - are you still following up on those by hand?',
      call_opener: `Hi, this is Sam calling for ${name}. Quick one - how do you follow up on estimates that go quiet?`,
      rationale: 'Leads with a concrete, low-friction question about a known gap.',
      confidence: 0.6,
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

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match?.[1]?.trim() ?? null;
}
