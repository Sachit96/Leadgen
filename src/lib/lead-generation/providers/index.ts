import { env } from '@/lib/env';
import { GooglePlacesProvider } from './google-places';
import { MockDiscoveryProvider } from './mock';
import { DiscoveryError, type LeadDiscoveryProvider } from './types';

export * from './types';
export { GooglePlacesProvider } from './google-places';
export { MockDiscoveryProvider } from './mock';

declare global {
  var __onRadarDiscoveryProvider: LeadDiscoveryProvider | undefined;
}

/**
 * Resolves the discovery provider.
 *
 * A provider that is *selected* but not *configured* is a configuration error,
 * not a reason to quietly substitute synthetic data. Falling back would make a
 * misconfigured production deployment look like a working one, and the leads it
 * produced would be fictional businesses with 555 numbers sitting in a real
 * call queue. So this throws, and the UI surfaces it.
 *
 * `mock` remains a legitimate explicit choice for demos and tests — the
 * difference is that someone asked for it.
 */
export function getDiscoveryProvider(): LeadDiscoveryProvider {
  if (globalThis.__onRadarDiscoveryProvider) return globalThis.__onRadarDiscoveryProvider;

  const e = env();
  let provider: LeadDiscoveryProvider;

  if (e.LEAD_DISCOVERY_PROVIDER === 'google_places') {
    if (!e.GOOGLE_PLACES_API_KEY) {
      throw new DiscoveryError(
        'Lead discovery is set to google_places but GOOGLE_PLACES_API_KEY is not set. ' +
          'Set the key, or set LEAD_DISCOVERY_PROVIDER=mock to run on synthetic data.',
        { code: 'NOT_CONFIGURED' },
      );
    }
    provider = new GooglePlacesProvider({
      apiKey: e.GOOGLE_PLACES_API_KEY,
      maxRequests: Number(e.LEAD_DISCOVERY_MAX_REQUESTS ?? 10),
    });
  } else {
    provider = new MockDiscoveryProvider();
  }

  globalThis.__onRadarDiscoveryProvider = provider;
  return provider;
}

/**
 * The provider, or the reason there isn't one.
 *
 * For read paths — a settings page or a search form should be able to say
 * "discovery is misconfigured" without throwing on render.
 */
export function discoveryProviderStatus():
  | { ok: true; provider: LeadDiscoveryProvider }
  | { ok: false; error: string; code: string } {
  try {
    return { ok: true, provider: getDiscoveryProvider() };
  } catch (error) {
    if (error instanceof DiscoveryError) {
      return { ok: false, error: error.message, code: error.code };
    }
    throw error;
  }
}

export function setDiscoveryProvider(provider: LeadDiscoveryProvider | undefined): void {
  globalThis.__onRadarDiscoveryProvider = provider;
}
