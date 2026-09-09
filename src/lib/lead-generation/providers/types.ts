/**
 * The lead discovery boundary.
 *
 * No business logic imports a discovery vendor. Everything above this line
 * speaks `LeadDiscoveryProvider`; everything below translates one source into
 * it.
 *
 * The referenced Apify/Playwright Google Maps actor was inspected as a
 * reference (see docs/LEAD_GENERATION_AUDIT.md). It carries no LICENSE file,
 * so none of its code is used here. Two of its ideas do transfer and are
 * applied by the adapters below: geographic tiling to get past a single
 * search's result cap, and bounded pagination with an explicit request budget.
 */
export type DiscoveryProviderKind = 'google_places' | 'csv' | 'mock';

export type SearchFilters = {
  minReviews?: number;
  minRating?: number;
  requireWebsite?: boolean;
  requirePhone?: boolean;
  requireSocial?: boolean;
  openNow?: boolean;
};

export type SearchRequest = {
  /** Free text: "roofing", "roofing contractor", "HVAC". */
  query: string;
  /** Free text: "Mississauga, ON". Adapters geocode as needed. */
  location: string;
  radiusMeters: number;
  /** Upper bound on results. Adapters must not exceed it. */
  limit: number;
  filters?: SearchFilters;
  /** Aborts an in-flight search when a job is cancelled. */
  signal?: AbortSignal;
};

/**
 * One discovered business, in provider-neutral shape.
 *
 * Everything is optional except the name and the raw payload — a discovery
 * source that only knows a name and an address is still a lead, and dropping
 * the record would lose information the enrichment stage could recover.
 */
export type DiscoveredBusiness = {
  externalId: string | null;
  businessName: string;
  phone: string | null;
  website: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  category: string | null;
  categories: string[];
  rating: number | null;
  reviewCount: number | null;
  latitude: number | null;
  longitude: number | null;
  hours: string[] | null;
  socialUrls: Record<string, string>;
  sourceUrl: string | null;
  /** Verbatim provider payload. Never edited; provenance depends on it. */
  raw: unknown;
};

export type SearchResult = {
  businesses: DiscoveredBusiness[];
  /** Requests actually issued — surfaced so cost is visible. */
  requestsUsed: number;
  /** True when the provider had more results than the limit allowed. */
  truncated: boolean;
};

export type ProviderAvailability = {
  available: boolean;
  reason?: string;
};

export class DiscoveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, opts: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = opts.code ?? 'DISCOVERY_ERROR';
    this.retryable = opts.retryable ?? false;
  }
}

export interface LeadDiscoveryProvider {
  readonly kind: DiscoveryProviderKind;
  readonly configured: boolean;

  searchBusinesses(request: SearchRequest): Promise<SearchResult>;
  getBusiness(externalId: string): Promise<DiscoveredBusiness | null>;
  /** Maps a raw provider payload into the neutral shape. Pure. */
  normalizeBusiness(raw: unknown): DiscoveredBusiness | null;
  checkAvailability(): Promise<ProviderAvailability>;
}

/** Applied by the pipeline after discovery, so every adapter behaves the same. */
export function passesFilters(business: DiscoveredBusiness, filters?: SearchFilters): boolean {
  if (!filters) return true;
  if (filters.minReviews !== undefined && (business.reviewCount ?? 0) < filters.minReviews) return false;
  if (filters.minRating !== undefined && (business.rating ?? 0) < filters.minRating) return false;
  if (filters.requireWebsite && !business.website) return false;
  if (filters.requirePhone && !business.phone) return false;
  if (filters.requireSocial && Object.keys(business.socialUrls).length === 0) return false;
  return true;
}
