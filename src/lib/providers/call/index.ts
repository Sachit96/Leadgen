import { env } from '@/lib/env';
import { DeviceCallProvider } from './device';
import type { CallProvider } from './types';

export * from './types';
export { DeviceCallProvider } from './device';

declare global {
  var __onRadarCallProvider: CallProvider | undefined;
}

/**
 * Resolves the call provider.
 *
 * Only device telephony ships today. The interface exists so a voice provider
 * can be added without touching the queue, the dispositions or the analytics —
 * and when one is, `reportsConnection` becomes true and connect rate stops
 * being operator-reported.
 */
export function getCallProvider(): CallProvider {
  if (globalThis.__onRadarCallProvider) return globalThis.__onRadarCallProvider;

  // Reading the variable validates it and keeps the selection in one place;
  // `device` is the only value the enum accepts, so there is nothing to branch
  // on yet. A voice provider adds a case here and nothing else.
  void env().CALL_PROVIDER;
  const provider: CallProvider = new DeviceCallProvider();

  globalThis.__onRadarCallProvider = provider;
  return provider;
}

export function setCallProvider(provider: CallProvider | undefined): void {
  globalThis.__onRadarCallProvider = provider;
}
