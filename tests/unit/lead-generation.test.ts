import { describe, it, expect } from 'vitest';
import {
  normalizeWebsite,
  websiteDomain,
  normalizeBusinessName,
  normalizeProvince,
  normalizeCity,
  normalizePostalCode,
  nameSimilarity,
  addressSimilarity,
  normalizeDiscoveredBusiness,
} from '@/lib/lead-generation/normalize';
import { passesFilters } from '@/lib/lead-generation/providers/types';
import { MockDiscoveryProvider } from '@/lib/lead-generation/providers/mock';
import { htmlToText, extractSocialUrls, extractEmails, extractPhones, extractSite } from '@/lib/enrichment/extract';
import { detectSignals, scoreWebsiteQuality, hasWeakConversionInfrastructure, hasAdvertisingEvidence } from '@/lib/enrichment/signals';

describe('website normalization', () => {
  it('strips tracking parameters, www and trailing slashes', () => {
    expect(normalizeWebsite('http://WWW.Example.com/?utm_source=google&gclid=abc')?.url).toBe(
      'https://example.com',
    );
    expect(normalizeWebsite('example.com/services/')?.url).toBe('https://example.com/services');
    expect(normalizeWebsite('https://example.com/a?page=2&fbclid=x')?.url).toBe(
      'https://example.com/a?page=2',
    );
  });

  it('collapses the forms of one site to a single dedupe domain', () => {
    const forms = ['http://example.com', 'https://www.example.com/', 'example.com/contact'];
    const domains = new Set(forms.map((f) => websiteDomain(f)));
    expect(domains).toEqual(new Set(['example.com']));
  });

  it('rejects things that are not websites', () => {
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsite('not a url')).toBeNull();
    expect(normalizeWebsite('')).toBeNull();
    expect(normalizeWebsite(null)).toBeNull();
  });
});

describe('business name normalization', () => {
  it('collapses legal suffixes and punctuation to one key', () => {
    const key = normalizeBusinessName('ABC Roofing & Sons Inc.');
    expect(normalizeBusinessName('abc roofing and sons')).toBe(key);
    expect(normalizeBusinessName('ABC Roofing & Sons, LLC')).toBe(key);
  });

  it('keeps genuinely different businesses distinct', () => {
    expect(normalizeBusinessName('ABC Roofing')).not.toBe(normalizeBusinessName('XYZ Roofing'));
  });

  it('normalizes locations', () => {
    expect(normalizeProvince('Ontario')).toBe('ON');
    expect(normalizeProvince('on')).toBe('ON');
    expect(normalizeCity('  mississauga ')).toBe('Mississauga');
    expect(normalizePostalCode('l5b1m2')).toBe('L5B 1M2');
  });
});

describe('similarity scoring', () => {
  it('scores name overlap', () => {
    expect(nameSimilarity('abc roofing', 'abc roofing')).toBe(1);
    expect(nameSimilarity('abc roofing', 'abc roofing services')).toBeGreaterThan(0.7);
    expect(nameSimilarity('abc roofing', 'xyz plumbing')).toBe(0);
  });

  it('requires a matching street number before considering an address a match', () => {
    expect(addressSimilarity('123 Dundas St, Mississauga', '123 Dundas St, Mississauga')).toBe(1);
    expect(addressSimilarity('123 Dundas St', '456 Dundas St')).toBe(0);
    expect(addressSimilarity(null, '123 Dundas St')).toBe(0);
  });
});

describe('discovery filters', () => {
  const business = {
    externalId: 'x', businessName: 'Test', phone: '+14165550123', website: 'https://t.example',
    addressLine: null, city: null, province: null, postalCode: null, country: null,
    category: null, categories: [], rating: 4.5, reviewCount: 100, latitude: null,
    longitude: null, hours: null, socialUrls: {}, sourceUrl: null, raw: {},
  };

  it('applies each filter independently', () => {
    expect(passesFilters(business, { minReviews: 50 })).toBe(true);
    expect(passesFilters(business, { minReviews: 500 })).toBe(false);
    expect(passesFilters(business, { minRating: 4 })).toBe(true);
    expect(passesFilters(business, { minRating: 4.8 })).toBe(false);
    expect(passesFilters({ ...business, website: null }, { requireWebsite: true })).toBe(false);
    expect(passesFilters({ ...business, phone: null }, { requirePhone: true })).toBe(false);
    expect(passesFilters(business, {})).toBe(true);
  });
});

describe('mock discovery provider', () => {
  it('is deterministic, so re-running a search finds the same businesses', async () => {
    const provider = new MockDiscoveryProvider();
    const request = { query: 'roofing', location: 'Mississauga, ON', radiusMeters: 25_000, limit: 20 };

    const first = await provider.searchBusinesses(request);
    const second = await provider.searchBusinesses(request);

    expect(first.businesses.length).toBe(20);
    expect(first.businesses.map((b) => b.externalId)).toEqual(second.businesses.map((b) => b.externalId));
  });

  it('only produces numbers and domains that cannot reach a real business', async () => {
    const provider = new MockDiscoveryProvider();
    const { businesses } = await provider.searchBusinesses({
      query: 'roofing', location: 'Toronto, ON', radiusMeters: 25_000, limit: 50,
    });

    for (const business of businesses) {
      // 555-01xx is reserved for fiction; .example is reserved by RFC 2606.
      if (business.phone) expect(business.phone, business.phone).toMatch(/^\+1\d{3}555\d{4}$/);
      if (business.website) expect(business.website, business.website).toMatch(/\.example(\/|$)/);
    }
  });

  it('honours the requested limit and filters', async () => {
    const provider = new MockDiscoveryProvider();
    const { businesses } = await provider.searchBusinesses({
      query: 'hvac', location: 'Burlington, ON', radiusMeters: 10_000, limit: 15,
      filters: { minReviews: 50, requireWebsite: true },
    });

    expect(businesses.length).toBeLessThanOrEqual(15);
    for (const business of businesses) {
      expect(business.reviewCount ?? 0).toBeGreaterThanOrEqual(50);
      expect(business.website).toBeTruthy();
    }
  });

  it('normalizes provider output into the CRM shape', async () => {
    const provider = new MockDiscoveryProvider();
    const { businesses } = await provider.searchBusinesses({
      query: 'roofing', location: 'Mississauga, ON', radiusMeters: 25_000, limit: 5,
      filters: { requirePhone: true, requireWebsite: true },
    });

    const normalized = normalizeDiscoveredBusiness(businesses[0]!);
    expect(normalized.phone).toMatch(/^\+1\d{10}$/);
    expect(normalized.phoneValid).toBe(true);
    expect(normalized.websiteDomain).not.toContain('https://');
    expect(normalized.nameKey).toBe(normalized.nameKey?.toLowerCase());
    expect(normalized.province).toBe('ON');
  });
});

describe('HTML extraction', () => {
  const html = `
    <html><head>
      <title>Summit Roofing | Mississauga</title>
      <meta name="viewport" content="width=device-width">
      <meta name="description" content="Roof replacement and repair in Mississauga">
      <script src="https://www.googletagmanager.com/gtag/js?id=AW-12345"></script>
      <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
    </head><body>
      <a href="tel:+19055550142">(905) 555-0142</a>
      <a href="mailto:info@summit.example">Email us</a>
      <a href="https://www.facebook.com/summitroofing">Facebook</a>
      <a href="https://www.facebook.com/sharer/share?u=x">Share</a>
      <a href="https://instagram.com/summitroofing">Instagram</a>
      <a href="https://calendly.com/summit/estimate">Book an estimate</a>
      <p>We do roof replacement and roof repair. Get a free quote today.</p>
      <form><input type="email" name="email"></form>
      <style>.x{color:red}</style>
      <script>var secret = 'should not appear';</script>
    </body></html>`;

  it('strips scripts and styles from text', () => {
    const text = htmlToText(html);
    expect(text).toContain('roof replacement');
    expect(text).not.toContain('should not appear');
    expect(text).not.toContain('color:red');
  });

  it('extracts contact details and real social profiles only', () => {
    const text = htmlToText(html);
    expect(extractEmails(html, text)).toContain('info@summit.example');
    expect(extractPhones(html, text)).toContain('+19055550142');

    const social = extractSocialUrls(html);
    expect(social.facebook).toBe('https://www.facebook.com/summitroofing');
    expect(social.instagram).toBe('https://instagram.com/summitroofing');
    // A share link is not the business's profile.
    expect(social.facebook).not.toContain('sharer');
  });

  it('detects signals with the evidence that produced them', () => {
    const pages = [{ path: '/', url: 'https://summit.example/', status: 200, html, bytes: html.length }];
    const site = extractSite(pages);
    const { signals, quality } = detectSignals(pages, site, 'https://summit.example');

    const ads = signals.find((s) => s.key === 'google_ads')!;
    expect(ads.detected).toBe(true);
    expect(ads.evidence).toContain('AW-');
    expect(ads.inferred).toBe(false);

    const pixel = signals.find((s) => s.key === 'meta_pixel')!;
    expect(pixel.detected).toBe(true);

    // Not detected must carry no evidence — absence is never a claim.
    const crm = signals.find((s) => s.key === 'field_service_crm')!;
    expect(crm.detected).toBe(false);
    expect(crm.evidence).toBeNull();

    expect(quality.has_phone_visible).toBe(true);
    expect(quality.has_lead_form).toBe(true);
    expect(quality.has_clear_cta).toBe(true);
    expect(quality.has_online_booking).toBe(true);
    expect(hasAdvertisingEvidence(signals)).toBe(true);
  });

  it('scores website quality and flags weak conversion infrastructure', () => {
    const strong = {
      has_ssl: true, has_mobile_viewport: true, has_contact_form: true, has_booking_flow: true,
      has_clear_cta: true, has_phone_visible: true, has_lead_form: true, has_chat_widget: true,
      has_online_booking: true, has_service_pages: true, website_load_success: true,
    };
    expect(scoreWebsiteQuality(strong)).toBe(100);

    const bare = { ...strong, has_booking_flow: false, has_chat_widget: false, has_online_booking: false };
    expect(scoreWebsiteQuality(bare)).toBeLessThan(100);

    // No CRM, no booking, no chat — the ideal On Radar prospect.
    expect(hasWeakConversionInfrastructure(bare, [])).toBe(true);
    expect(
      hasWeakConversionInfrastructure(bare, [
        { key: 'field_service_crm', category: 'crm', detected: true, confidence: 1, evidence: 'jobber.com', source: 'website', inferred: false },
      ]),
    ).toBe(false);
  });
});
