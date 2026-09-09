import { env } from '@/lib/env';
import { AnthropicProvider } from './anthropic';
import { MockAiProvider } from './mock';
import type { AiProvider } from './types';

export * from './types';
export { MockAiProvider } from './mock';
export { AnthropicProvider } from './anthropic';

declare global {
  var __onRadarAiProvider: AiProvider | undefined;
}

export function getAiProvider(): AiProvider {
  if (globalThis.__onRadarAiProvider) return globalThis.__onRadarAiProvider;

  const e = env();
  let provider: AiProvider;

  if (e.AI_PROVIDER === 'anthropic') {
    const anthropic = new AnthropicProvider({
      apiKey: e.ANTHROPIC_API_KEY ?? '',
      fastModel: e.AI_MODEL_FAST,
      smartModel: e.AI_MODEL_SMART,
    });
    provider = anthropic.configured ? anthropic : new MockAiProvider();
  } else {
    provider = new MockAiProvider();
  }

  globalThis.__onRadarAiProvider = provider;
  return provider;
}

export function setAiProvider(provider: AiProvider | undefined): void {
  globalThis.__onRadarAiProvider = provider;
}
