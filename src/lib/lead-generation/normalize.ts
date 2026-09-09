import { normalizeEmail, normalizePhone } from '@/lib/core/phone';
import type { DiscoveredBusiness } from './providers/types';

/**
 * Turns provider output into the canonical shape the CRM stores.
 *
 * Reuses the existing phone/email normalizers rather than re-implementing them,
 * so a lead discovered by search and a lead uploaded by CSV end up with byte
 * identical keys — which is what makes cross-source deduplication work.
 */

/** Query parameters that identify a campaign, not a page. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'mc_cid', 'mc_eid', 'ref', 'referrer',
  '_ga', '_gl', 'igshid', 'si', 'yclid',
];

export type NormalizedUrl = {
  /** Cleaned, canonical absolute URL. */
  url: string;
  /** Registrable domain, lowercased, `www.` removed. The dedupe key. */
  domain: string;
} | null;

export function normalizeWebsite(input: string | null | undefined): NormalizedUrl {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Normalize the protocol: a site reachable on both is one site.
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.hash = '';

  for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
  parsed.search = parsed.searchParams.toString() ? `?${parsed.searchParams}` : '';

  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;

  // Computed rather than assigned: the URL spec refuses to clear `pathname` for
  // http(s), so `parsed.pathname = ''` is silently ignored and both
  // "https://example.com" and "https://example.com/" would survive as forms.
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  const port = parsed.port ? `:${parsed.port}` : '';

  return { url: `${parsed.protocol}//${parsed.hostname}${port}${path}${parsed.search}`, domain: parsed.hostname };
}

export function websiteDomain(input: string | null | undefined): string | null {
  return normalizeWebsite(input)?.domain ?? null;
}

const LEGAL_SUFFIXES = [
  'inc', 'incorporated', 'llc', 'l l c', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'lp', 'llp', 'pc', 'gmbh', 'bv', 'sa', 'pty',
];

/**
 * Comparison key for a business name.
 *
 * Strips punctuation, legal suffixes and the word "and", so "ABC Roofing &
 * Sons Inc." and "abc roofing and sons" collapse to the same key. Display names
 * are never replaced by this.
 */
export function normalizeBusinessName(name: string | null | undefined): string | null {
  if (!name) return null;
  let value = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Legal suffixes only count at the end of the name.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (value.endsWith(` ${suffix}`)) {
        value = value.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }

  value = value.replace(/\band\b/g, '').replace(/\s+/g, ' ').trim();
  return value || null;
}

const PROVINCE_CODES: Record<string, string> = {
  ontario: 'ON', quebec: 'QC', 'british columbia': 'BC', alberta: 'AB', manitoba: 'MB',
  saskatchewan: 'SK', 'nova scotia': 'NS', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'prince edward island': 'PE',
};

export function normalizeProvince(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (trimmed.length <= 3) return trimmed.toUpperCase();
  return PROVINCE_CODES[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeCity(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed
    .split(' ')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

/** Canadian postal codes get the conventional "A1A 1A1" spacing. */
export function normalizePostalCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = String(input).trim().toUpperCase().replace(/\s+/g, '');
  if (!value) return null;
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(value)) return `${value.slice(0, 3)} ${value.slice(3)}`;
  return value;
}

export type NormalizedLead = {
  businessName: string;
  nameKey: string | null;
  phone: string | null;
  phoneRaw: string | null;
  phoneValid: boolean;
  email: string | null;
  website: string | null;
  websiteDomain: string | null;
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
  externalId: string | null;
};

export function normalizeDiscoveredBusiness(business: DiscoveredBusiness): NormalizedLead {
  const phone = normalizePhone(business.phone, 'CA');
  const site = normalizeWebsite(business.website);

  return {
    businessName: business.businessName.trim(),
    nameKey: normalizeBusinessName(business.businessName),
    phone: phone.e164,
    phoneRaw: business.phone,
    phoneValid: phone.valid,
    email: normalizeEmail(null),
    website: site?.url ?? null,
    websiteDomain: site?.domain ?? null,
    addressLine: business.addressLine?.trim() ?? null,
    city: normalizeCity(business.city),
    province: normalizeProvince(business.province),
    postalCode: normalizePostalCode(business.postalCode),
    country: business.country?.trim().toUpperCase() ?? null,
    category: business.category?.trim() ?? null,
    categories: business.categories.filter(Boolean),
    rating: business.rating,
    reviewCount: business.reviewCount,
    latitude: business.latitude,
    longitude: business.longitude,
    hours: business.hours,
    socialUrls: business.socialUrls,
    sourceUrl: business.sourceUrl,
    externalId: business.externalId,
  };
}

/**
 * Token-overlap similarity, 0-1. Used only as the last dedupe tier, paired with
 * an address check, because names alone are weak evidence.
 */
export function nameSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** Compares street numbers and the first street token — cheap and effective. */
export function addressSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const key = (value: string) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const streetNumber = /^(\d+)/.exec(normalized)?.[1] ?? '';
    const tokens = normalized.split(' ').filter((t) => t.length > 2 && !/^\d+$/.test(t));
    return { streetNumber, first: tokens[0] ?? '' };
  };
  const left = key(a);
  const right = key(b);
  if (!left.streetNumber || !right.streetNumber) return 0;
  if (left.streetNumber !== right.streetNumber) return 0;
  return left.first && left.first === right.first ? 1 : 0.6;
}
