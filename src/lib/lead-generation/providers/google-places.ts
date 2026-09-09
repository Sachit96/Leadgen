import {
  DiscoveryError,
  passesFilters,
  type DiscoveredBusiness,
  type LeadDiscoveryProvider,
  type ProviderAvailability,
  type SearchRequest,
  type SearchResult,
} from './types';

const PLACES_BASE = 'https://places.googleapis.com/v1';

/**
 * Google Places API (New).
 *
 * This is the official, terms-compliant route to Maps business data, and it
 * returns exactly the discovery fields the pipeline needs. It is used instead
 * of driving the Maps UI with a headless browser: the reference implementation
 * for that approach ships without a license, and scraping the UI is outside
 * Google's terms regardless.
 *
 * Cost control matters here — Places bills per request — so the adapter asks
 * for a precise field mask, paginates against an explicit budget, and stops the
 * moment the caller's limit is met.
 */
export type GooglePlacesConfig = {
  apiKey: string;
  /** Ceiling on requests per search, so one job cannot run up a bill. */
  maxRequests?: number;
};

/** Only the fields we store, so Google bills the cheapest applicable SKU. */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.businessStatus',
].join(',');

type PlacesAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type PlacesPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: PlacesAddressComponent[];
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  businessStatus?: string;
};

function component(place: PlacesPlace, type: string): string | null {
  const match = place.addressComponents?.find((c) => c.types?.includes(type));
  return match?.longText ?? match?.shortText ?? null;
}

function shortComponent(place: PlacesPlace, type: string): string | null {
  const match = place.addressComponents?.find((c) => c.types?.includes(type));
  return match?.shortText ?? match?.longText ?? null;
}

export class GooglePlacesProvider implements LeadDiscoveryProvider {
  readonly kind = 'google_places' as const;
  readonly configured: boolean;
  private readonly config: GooglePlacesConfig;

  constructor(config: GooglePlacesConfig) {
    this.config = config;
    this.configured = Boolean(config.apiKey);
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    if (!this.configured) {
      return { available: false, reason: 'GOOGLE_PLACES_API_KEY is not set' };
    }
    try {
      // One minimal request confirms the key is live and billing is enabled.
      const response = await this.post('/places:searchText', { textQuery: 'coffee', pageSize: 1 }, 'places.id');
      return response.ok
        ? { available: true }
        : { available: false, reason: `Places API returned ${response.status}` };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  private post(path: string, body: unknown, fieldMask: string, signal?: AbortSignal) {
    return fetch(`${PLACES_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.config.apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  async searchBusinesses(request: SearchRequest): Promise<SearchResult> {
    if (!this.configured) {
      throw new DiscoveryError('Google Places is not configured (set GOOGLE_PLACES_API_KEY)', {
        code: 'NOT_CONFIGURED',
      });
    }

    const businesses: DiscoveredBusiness[] = [];
    const seen = new Set<string>();
    const maxRequests = this.config.maxRequests ?? 10;
    let requestsUsed = 0;
    let pageToken: string | undefined;
    let truncated = false;

    while (businesses.length < request.limit && requestsUsed < maxRequests) {
      if (request.signal?.aborted) break;

      // Places caps pageSize at 20 and total results at 60 per query.
      const pageSize = Math.min(20, request.limit - businesses.length);
      const body: Record<string, unknown> = {
        textQuery: `${request.query} in ${request.location}`,
        pageSize,
      };
      if (pageToken) body.pageToken = pageToken;
      if (request.filters?.openNow) body.openNow = true;
      if (request.filters?.minRating) body.minRating = request.filters.minRating;

      const response = await this.post(
        '/places:searchText',
        body,
        `${FIELD_MASK},nextPageToken`,
        request.signal,
      );
      requestsUsed += 1;

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new DiscoveryError(
          `Google Places returned ${response.status}: ${detail.slice(0, 300)}`,
          {
            code: `HTTP_${response.status}`,
            // 429 and 5xx are worth another attempt; 4xx are not.
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      }

      const payload = (await response.json()) as { places?: PlacesPlace[]; nextPageToken?: string };
      const places = payload.places ?? [];
      if (places.length === 0) break;

      for (const place of places) {
        const normalized = this.normalizeBusiness(place);
        if (!normalized) continue;
        const key = normalized.externalId ?? normalized.businessName;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!passesFilters(normalized, request.filters)) continue;
        businesses.push(normalized);
      }

      pageToken = payload.nextPageToken;
      if (!pageToken) break;
      if (businesses.length >= request.limit) {
        truncated = true;
        break;
      }
    }

    if (pageToken && requestsUsed >= maxRequests) truncated = true;
    return { businesses: businesses.slice(0, request.limit), requestsUsed, truncated };
  }

  async getBusiness(externalId: string): Promise<DiscoveredBusiness | null> {
    if (!this.configured) return null;
    const response = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(externalId)}`, {
      headers: {
        'X-Goog-Api-Key': this.config.apiKey,
        'X-Goog-FieldMask': FIELD_MASK.replaceAll('places.', ''),
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new DiscoveryError(`Google Places lookup returned ${response.status}`, {
        code: `HTTP_${response.status}`,
        retryable: response.status >= 500,
      });
    }
    return this.normalizeBusiness(await response.json());
  }

  normalizeBusiness(raw: unknown): DiscoveredBusiness | null {
    const place = raw as PlacesPlace;
    const name = place?.displayName?.text?.trim();
    if (!name) return null;

    // Permanently closed businesses are not leads.
    if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return null;

    return {
      externalId: place.id ?? null,
      businessName: name,
      // Prefer the international form: it is already close to E.164.
      phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      addressLine: place.formattedAddress ?? null,
      city:
        component(place, 'locality') ??
        component(place, 'postal_town') ??
        component(place, 'administrative_area_level_2'),
      province: shortComponent(place, 'administrative_area_level_1'),
      postalCode: component(place, 'postal_code'),
      country: shortComponent(place, 'country'),
      category: place.primaryTypeDisplayName?.text ?? place.types?.[0] ?? null,
      categories: place.types ?? [],
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? null,
      latitude: place.location?.latitude ?? null,
      longitude: place.location?.longitude ?? null,
      hours: place.regularOpeningHours?.weekdayDescriptions ?? null,
      // Places does not return social profiles; the website crawler finds them.
      socialUrls: {},
      sourceUrl: place.googleMapsUri ?? null,
      raw: place,
    };
  }
}
