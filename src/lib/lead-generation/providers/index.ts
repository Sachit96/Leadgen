import { env } from '@/lib/env';
import { GooglePlacesProvider } from './google-places';
import { MockDiscoveryProvider } from './mock';
import type { LeadDiscoveryProvider } from './types';

export * from './types';
export { GooglePlacesProvider } from './google-places';
export { MockDiscoveryProvider } from './mock';

declare global {
  var __onRadarDiscoveryProvider: LeadDiscoveryProvider | undefined;
}

/**
 * Resolves the discovery provider.
 *
 * A provider selected but not configured falls back to the synthetic one, and
 * `configured` stays false on that path so Settings can say plainly that
 * discovery is running on demo data.
 */
export function getDiscoveryProvider(): LeadDiscoveryProvider {
  if (globalThis.__onRadarDiscoveryProvider) return globalThis.__onRadarDiscoveryProvider;

  const e = env();
  let provider: LeadDiscoveryProvider;

  if (e.LEAD_DISCOVERY_PROVIDER === 'google_places') {
    const google = new GooglePlacesProvider({
      apiKey: e.GOOGLE_PLACES_API_KEY ?? '',
      maxRequests: Number(e.LEAD_DISCOVERY_MAX_REQUESTS ?? 10),
    });
    provider = google.configured ? google : new MockDiscoveryProvider();
  } else {
    provider = new MockDiscoveryProvider();
  }

  globalThis.__onRadarDiscoveryProvider = provider;
  return provider;
}

export function setDiscoveryProvider(provider: LeadDiscoveryProvider | undefined): void {
  globalThis.__onRadarDiscoveryProvider = provider;
}
