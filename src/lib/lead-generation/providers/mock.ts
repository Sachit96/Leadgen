import { createHash } from 'node:crypto';
import {
  passesFilters,
  type DiscoveredBusiness,
  type LeadDiscoveryProvider,
  type ProviderAvailability,
  type SearchRequest,
  type SearchResult,
} from './types';

/**
 * Deterministic synthetic discovery, for demo mode and tests.
 *
 * It is a real implementation of the interface — the same normalization,
 * deduplication, enrichment and scoring run over its output — so the whole
 * pipeline is exercised without a Places key or a single network request.
 *
 * Everything it emits is unmistakably synthetic: 555-01xx phone numbers (the
 * NANP range reserved for fiction) and `.example` domains (reserved by RFC 2606
 * and unresolvable). Nothing it produces can reach a real business.
 */
const NAME_PREFIXES = [
  'Summit', 'Northgate', 'Trueline', 'Ironclad', 'Bluewater', 'Cedar Ridge', 'Maple Crest',
  'Lakeshore', 'Kingsway', 'Redstone', 'Silverline', 'Copperfield', 'Harbourview', 'Stonebridge',
  'Westfield', 'Pinnacle', 'Granite', 'Fairview', 'Oakmont', 'Brightpath',
];

const NAME_SUFFIXES = ['& Sons', 'Group', 'Co.', 'Services', 'Contracting', 'Solutions', 'Ltd.', 'Inc.'];

const STREETS = ['Dundas St', 'Lakeshore Rd', 'Main St', 'Queen St', 'Bloor St', 'Hurontario St', 'Steeles Ave'];

/** Area codes actually used across the GTA, so demo data looks plausible. */
const AREA_CODES = ['416', '647', '905', '289', '437'];

/**
 * A small deterministic PRNG.
 *
 * Seeded from the query, so the same search always produces the same
 * businesses — which is what makes deduplication testable: re-running a search
 * must find the existing records rather than inventing new ones.
 */
function makeRandom(seed: string): () => number {
  let hash = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    hash = (hash * 1_664_525 + 1_013_904_223) >>> 0;
    return hash / 0x1_0000_0000;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)]!;
}

export class MockDiscoveryProvider implements LeadDiscoveryProvider {
  readonly kind = 'mock' as const;
  readonly configured = true;

  /** When set, the next search throws — used to test failure handling. */
  failNext = false;
  /** When set, the next search returns nothing — a market with no matches. */
  emptyNext = false;
  searches: SearchRequest[] = [];

  async checkAvailability(): Promise<ProviderAvailability> {
    return { available: true, reason: 'Synthetic discovery — no real businesses are contacted' };
  }

  async searchBusinesses(request: SearchRequest): Promise<SearchResult> {
    this.searches.push(request);
    if (this.failNext) {
      this.failNext = false;
      const { DiscoveryError } = await import('./types');
      throw new DiscoveryError('Mock discovery failure', { code: 'MOCK_FAILURE', retryable: true });
    }
    if (this.emptyNext) {
      this.emptyNext = false;
      return { businesses: [], requestsUsed: 1, truncated: false };
    }

    // "roofing contractor" and "roofing" should both read as one trade, not
    // produce "Roofing Contractor contractor" in every generated name.
    const trade = request.query.trim().toLowerCase().replace(/\s*(contractor|contractors|company|companies|services?)$/, '') || 'contracting';
    const city = request.location.split(',')[0]!.trim() || 'Toronto';
    const province = request.location.includes(',')
      ? request.location.split(',')[1]!.trim().toUpperCase()
      : 'ON';

    const businesses: DiscoveredBusiness[] = [];
    // Generate a surplus so filters have something to reject.
    const target = Math.min(request.limit, 200);

    for (let i = 0; i < target * 2 && businesses.length < target; i += 1) {
      const random = makeRandom(`${trade}|${city}|${i}`);
      const name = `${pick(random, NAME_PREFIXES)} ${titleCase(trade)} ${pick(random, NAME_SUFFIXES)}`;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Deliberately incomplete for some records, so enrichment and the
      // completeness score have real gaps to work with.
      const hasWebsite = random() > 0.2;
      const hasPhone = random() > 0.05;
      const reviewCount = Math.floor(random() ** 2 * 400);

      const business: DiscoveredBusiness = {
        externalId: `mock_${createHash('sha1').update(`${trade}|${city}|${i}`).digest('hex').slice(0, 20)}`,
        businessName: name,
        phone: hasPhone
          ? `+1${pick(random, AREA_CODES)}555${String(100 + Math.floor(random() * 99)).padStart(4, '0')}`
          : null,
        website: hasWebsite ? `https://${slug}.example` : null,
        addressLine: `${100 + Math.floor(random() * 8000)} ${pick(random, STREETS)}, ${city}, ${province}`,
        city,
        province,
        postalCode: null,
        country: 'CA',
        category: `${titleCase(trade)} contractor`,
        categories: [trade, 'contractor', 'point_of_interest'],
        rating: reviewCount > 0 ? Math.round((3.4 + random() * 1.6) * 10) / 10 : null,
        reviewCount: reviewCount || null,
        latitude: 43.5 + random(),
        longitude: -79.9 + random(),
        hours: ['Monday: 8:00 AM – 5:00 PM', 'Tuesday: 8:00 AM – 5:00 PM'],
        socialUrls: {},
        sourceUrl: `https://maps.example/place/${slug}`,
        raw: { synthetic: true, seed: `${trade}|${city}|${i}` },
      };

      if (passesFilters(business, request.filters)) businesses.push(business);
    }

    return { businesses, requestsUsed: 1, truncated: businesses.length >= target };
  }

  async getBusiness(externalId: string): Promise<DiscoveredBusiness | null> {
    const result = await this.searchBusinesses({
      query: 'contracting',
      location: 'Toronto, ON',
      radiusMeters: 25_000,
      limit: 200,
    });
    return result.businesses.find((b) => b.externalId === externalId) ?? null;
  }

  normalizeBusiness(raw: unknown): DiscoveredBusiness | null {
    return raw && typeof raw === 'object' && 'businessName' in raw ? (raw as DiscoveredBusiness) : null;
  }
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
