import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies, contacts, leadDiscoveryRecords, leadEnrichment, leadSignals } from '@/lib/db/schema';
import { createHarness, type Harness } from '../helpers/harness';
import { installTestEnv } from '../helpers/env';
import { contractorSite, installFakeWeb, type FakeWeb } from '../helpers/site';
import { crawlWebsite, classifyPath, sameOriginLinks } from '@/lib/enrichment/crawler';
import { extractSite, extractServiceAreas } from '@/lib/enrichment/extract';
import { detectSignals } from '@/lib/enrichment/signals';
import { createSearchJob, getSearchJob, searchOutcome, startSearchJob } from '@/lib/services/lead-search';
import { listLeads, getLeadDetail } from '@/lib/services/leads';
import { tick } from '@/lib/worker/tick';

async function drain(maxTicks = 60): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await tick({ sendBatch: 0, sequenceBatch: 0, aiBatch: 0, leadBatch: 25, skipMaintenance: true });
    if (result.leads.claimed === 0) return;
  }
}

describe('website crawling', () => {
  let web: FakeWeb;

  beforeEach(() => {
    installTestEnv();
    web = installFakeWeb({ 'summit.example': contractorSite() });
  });
  afterEach(() => web.restore());

  it('ranks a path by what it is likely to answer', () => {
    expect(classifyPath('/').role).toBe('home');
    expect(classifyPath('/our-services').role).toBe('services');
    expect(classifyPath('/get-in-touch').role).toBe('contact');
    expect(classifyPath('/free-estimate').role).toBe('quote');
    expect(classifyPath('/meet-the-team').role).toBe('about');
    expect(classifyPath('/areas-we-serve').role).toBe('service_area');
    expect(classifyPath('/random-page').weight).toBe(0);
    // A shallower page of the same role is worth more than a deep one.
    expect(classifyPath('/services').weight).toBeGreaterThan(classifyPath('/services/roofing/shingles').weight);
  });

  it('reads the site\'s own links and refuses the ones that are not ours to follow', () => {
    const html = `
      <a href="/services">rel</a>
      <a href="https://summit.example/contact">abs same origin</a>
      <a href="https://elsewhere.example/x">other origin</a>
      <a href="javascript:alert(1)">js</a>
      <a href="mailto:a@b.example">mail</a>
      <a href="/logo.png">asset</a>
      <a href="/privacy-policy">legal</a>`;
    const links = sameOriginLinks(html, 'https://summit.example');
    expect(links).toContain('/services');
    expect(links).toContain('/contact');
    expect(links).not.toContain('/logo.png');
    expect(links).not.toContain('/privacy-policy');
    expect(links.some((l) => l.includes('elsewhere'))).toBe(false);
    expect(links.some((l) => l.includes('alert'))).toBe(false);
  });

  it('finds pages a fixed path list would miss, and skips the ones not worth a request', async () => {
    const result = await crawlWebsite('https://summit.example', { maxPages: 8 });

    expect(result.ok).toBe(true);
    const paths = result.pages.map((p) => p.path);
    // None of these are in any hardcoded list — they came from the site's nav.
    expect(paths).toContain('/our-services');
    expect(paths).toContain('/meet-the-team');
    expect(paths).toContain('/get-in-touch');
    expect(paths).toContain('/free-estimate');
    // Legal pages and blog archives are never worth the request.
    expect(paths).not.toContain('/privacy-policy');

    // One page per role first, so the crawl covers the site rather than one corner.
    const roles = new Set(result.pages.map((p) => p.role));
    expect(roles).toContain('services');
    expect(roles).toContain('contact');
    expect(roles).toContain('about');

    // Every URL considered is accounted for.
    expect(result.attempts.length).toBeGreaterThanOrEqual(result.pages.length);
    expect(result.attempts.filter((a) => a.outcome === 'fetched')).toHaveLength(result.pages.length);
    expect(result.contentHash).toBeTruthy();
  });

  it('obeys robots.txt', async () => {
    web.restore();
    web = installFakeWeb({
      'summit.example': { ...contractorSite(), robots: 'User-agent: *\nDisallow: /get-in-touch\n' },
    });

    const result = await crawlWebsite('https://summit.example', { maxPages: 8 });
    expect(result.pages.map((p) => p.path)).not.toContain('/get-in-touch');
    expect(result.attempts.find((a) => a.path === '/get-in-touch')?.reason).toMatch(/robots/i);
    expect(web.requests).not.toContain('https://summit.example/get-in-touch');
  });

  it('reports a site that will not load instead of throwing', async () => {
    web.restore();
    web = installFakeWeb({ 'dead.example': { pages: {}, unreachable: true } });

    const result = await crawlWebsite('https://dead.example');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('FETCH_FAILED');
    expect(result.pages).toHaveLength(0);
    expect(result.attempts.some((a) => a.outcome === 'failed')).toBe(true);
  });

  it('refuses an unusable address without a request', async () => {
    const result = await crawlWebsite('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_URL');
    expect(web.requests).toHaveLength(0);
  });

  it('keeps the content of every page it fetched', async () => {
    const result = await crawlWebsite('https://summit.example', { maxPages: 8 });
    const site = extractSite(result.pages);

    expect(site.pages.length).toBe(result.pages.length);
    // The services page's actual words survive extraction.
    const services = site.pages.find((p) => p.role === 'services');
    expect(services?.text).toContain('roof replacement');
    expect(services?.headings).toContain('Roofing Services');
    expect(services?.url).toBe('https://summit.example/our-services');

    expect(site.serviceAreas).toContain('Oakville');
    expect(site.serviceAreas).toContain('Burlington');
    expect(site.emergencyMention).toMatch(/24\/7|emergency/i);
    expect(site.services).toContain('roof replacement');
    expect(site.phones).toContain('+19055550143');
    expect(site.emails).toContain('hello@summit.example');
    expect(site.description).toContain('roofs');
  });
});

describe('service area extraction', () => {
  it('reads areas from the words the business used', () => {
    expect(extractServiceAreas('Proudly serving Mississauga, Oakville and Burlington since 1998')).toEqual(
      expect.arrayContaining(['Mississauga', 'Oakville', 'Burlington']),
    );
    expect(extractServiceAreas('Areas we serve: Milton, Brampton, Etobicoke')).toEqual(
      expect.arrayContaining(['Milton', 'Brampton', 'Etobicoke']),
    );
    // Nothing claimed when nothing was said.
    expect(extractServiceAreas('We install roofs.')).toEqual([]);
  });

  it('reads areas from prose, not from the navigation menu', async () => {
    const { extractSite, stripChrome } = await import('@/lib/enrichment/extract');
    const { pageFromHtml } = await import('@/lib/enrichment/crawler');

    const html = `<html><body>
      <nav><a href="/services">Services</a><a href="/service-areas">Service Areas</a>
        <a href="/privacy-policy">Privacy</a></nav>
      <h1>Acme Roofing</h1>
      <p>Proudly serving Mississauga, Oakville and Burlington.</p>
      <footer><a href="/terms">Terms</a> <a href="/sitemap">Sitemap</a></footer>
    </body></html>`;

    expect(stripChrome(html)).not.toContain('Privacy');

    const site = extractSite([pageFromHtml('https://acme.example/', html)]);
    // Nav link text runs together into "Service Areas ... Privacy", which used
    // to be read as a town this business serves.
    expect(site.serviceAreas).toEqual(expect.arrayContaining(['Mississauga', 'Oakville', 'Burlington']));
    expect(site.serviceAreas).not.toContain('Privacy');
    expect(site.serviceAreas).not.toContain('Sitemap');
  });

  it('does not read the heading it triggered on as a place name', async () => {
    const { extractSite } = await import('@/lib/enrichment/extract');
    const { pageFromHtml } = await import('@/lib/enrichment/crawler');

    // The trigger phrase and the site's own furniture sit exactly where a town
    // name goes, and used to be captured as one.
    expect(extractServiceAreas('Areas We Serve Proudly serving Mississauga and Oakville.')).toEqual([
      'Mississauga',
      'Oakville',
    ]);
    expect(extractServiceAreas('Service Areas Home Contact')).toEqual([]);

    // A two-word place still survives.
    expect(extractServiceAreas('Serving Greater Toronto and Niagara Falls.')).toEqual(
      expect.arrayContaining(['Greater Toronto', 'Niagara Falls']),
    );

    // The <head> no longer bleeds the page's own name into its prose.
    const site = extractSite([
      pageFromHtml(
        'https://acme.example/areas-we-serve',
        '<html><head><title>Acme | areas we serve</title></head><body>' +
          '<h2>Areas We Serve</h2><p>Proudly serving Guelph and Cambridge.</p></body></html>',
      ),
    ]);
    expect(site.serviceAreas).toEqual(['Guelph', 'Cambridge']);
  });
});

describe('booking link detection', () => {
  it('does not mistake facebook.com for a booking system', async () => {
    const { extractSite } = await import('@/lib/enrichment/extract');
    const { pageFromHtml } = await import('@/lib/enrichment/crawler');

    const withFacebook = extractSite([
      pageFromHtml('https://x.example/', '<a href="https://facebook.com/acme">us</a>'),
    ]);
    // "book." is a substring of "facebook.com"; a social link is not a booking flow.
    expect(withFacebook.bookingLinks).toEqual([]);

    const withBooking = extractSite([
      pageFromHtml(
        'https://x.example/',
        '<a href="https://calendly.com/acme/30min">book</a><a href="https://booking.acme.example/">book</a>',
      ),
    ]);
    expect(withBooking.bookingLinks).toHaveLength(2);

    // Square hosts stores as well as appointments.
    const square = extractSite([
      pageFromHtml('https://x.example/', '<a href="https://squareup.com/shop/acme">shop</a>'),
    ]);
    expect(square.bookingLinks).toEqual([]);
  });
});

describe('signal detection', () => {
  let web: FakeWeb;
  beforeEach(() => {
    installTestEnv();
    web = installFakeWeb({ 'summit.example': contractorSite() });
  });
  afterEach(() => web.restore());

  it('gives every detected signal evidence and a page to check it on', async () => {
    const crawl = await crawlWebsite('https://summit.example', { maxPages: 8 });
    const site = extractSite(crawl.pages);
    const { signals } = detectSignals(crawl.pages, site, crawl.origin);

    for (const signal of signals.filter((s) => s.detected)) {
      expect(signal.evidence, `${signal.key} has no evidence`).toBeTruthy();
      expect(signal.sourceUrl, `${signal.key} has no source url`).toMatch(/^https:\/\/summit\.example/);
    }
    // A signal we did not find claims nothing at all.
    for (const signal of signals.filter((s) => !s.detected)) {
      expect(signal.evidence).toBeNull();
      expect(signal.sourceUrl).toBeNull();
    }
  });

  it('detects the sales signals, not just the technology', async () => {
    const crawl = await crawlWebsite('https://summit.example', { maxPages: 8 });
    const site = extractSite(crawl.pages);
    const { signals } = detectSignals(crawl.pages, site, crawl.origin);
    const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));

    // The fixture runs Google Ads with no CRM, booking flow or chat widget.
    expect(byKey.paying_for_traffic?.detected).toBe(true);
    expect(byKey.paying_for_traffic?.evidence).toMatch(/advertising tag/i);
    expect(byKey.weak_conversion_infrastructure?.detected).toBe(true);
    expect(byKey.spending_without_conversion?.detected).toBe(true);
    expect(byKey.no_online_booking?.detected).toBe(true);

    // And the things that make it worth calling.
    expect(byKey.high_value_services?.detected).toBe(true);
    expect(byKey.large_service_area?.detected).toBe(true);
    expect(byKey.emergency_services?.detected).toBe(true);
    expect(byKey.emergency_services?.evidence).toMatch(/24\/7/i);

    // The fixture has a viewport, a form and a phone, so these must NOT fire.
    expect(byKey.outdated_website?.detected).toBe(false);
    expect(byKey.weak_contact_experience?.detected).toBe(false);

    // Every opportunity signal is marked as the judgement it is.
    expect(byKey.spending_without_conversion?.inferred).toBe(true);
  });
});

describe('end-to-end scrape', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('runs search → discover → crawl → research → score → dedupe → lead', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 6,
      filters: { requirePhone: true, requireWebsite: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const job = await getSearchJob(h.ctx, search.id);
    expect(job.status).toBe('COMPLETED');
    expect(job.discoveredCount).toBeGreaterThan(0);
    expect(job.crawledCount).toBeGreaterThan(0);
    expect(job.qualifiedCount).toBeGreaterThan(0);

    // --- the crawl actually happened, against the site's own pages ----------
    const records = await h.db.select().from(leadDiscoveryRecords);
    const crawled = records.filter((r) => r.crawlStatus === 'OK');
    expect(crawled.length).toBeGreaterThan(0);
    expect(crawled[0]!.pagesCrawled).toBeGreaterThan(1);
    expect(crawled[0]!.crawledAt).toBeTruthy();

    // --- and its content was stored, not thrown away -----------------------
    const enrichment = await h.db.select().from(leadEnrichment).where(eq(leadEnrichment.ok, true));
    expect(enrichment.length).toBeGreaterThan(0);
    type Stored = {
      pages?: Array<{ url: string; role: string; text: string; headings: string[] }>;
      attempts?: unknown[];
      serviceAreas?: string[];
    };
    const outputs = enrichment.map((row) => row.output as Stored);
    expect(outputs.some((o) => (o.pages?.length ?? 0) > 1)).toBe(true);
    // The services page's own words survive the whole way into storage.
    expect(
      outputs.some((o) => o.pages?.some((p) => p.role === 'services' && p.text.includes('roof repair'))),
    ).toBe(true);
    expect(outputs.every((o) => (o.attempts?.length ?? 0) > 0)).toBe(true);

    // --- THE regression this suite exists for ------------------------------
    // Crawler output must reach the research agent. Before this was fixed the
    // agent received only a title and meta description, and the untrusted-content
    // fence guarded a nearly empty block.
    const researchCalls = h.ai.calls.filter((c) => c.system.includes('AGENT: business_research'));
    expect(researchCalls.length).toBeGreaterThan(0);

    const prompts = researchCalls.map((c) => c.messages.at(-1)!.content);
    const withPages = prompts.filter((p) => p.includes('--- PAGE: '));
    expect(withPages.length).toBeGreaterThan(0);

    const prompt = withPages[0]!;
    // Real crawled page text, attributed to the page it came from.
    expect(prompt).toMatch(/--- PAGE: https:\/\/[^\s]+\.example[^\s]* \((home|services|about|contact|quote|service_area)\)/);
    expect(prompt).toMatch(/roof repair|roof replacement|siding/);
    // Still fenced, and the page content sits inside the fence.
    const fence = prompt.indexOf('===== BEGIN UNTRUSTED WEBSITE CONTENT =====');
    expect(fence).toBeGreaterThan(-1);
    expect(prompt.indexOf('--- PAGE: ')).toBeGreaterThan(fence);

    // --- signals, with evidence and a page ---------------------------------
    const signals = await h.db.select().from(leadSignals);
    const detected = signals.filter((s) => s.detected);
    expect(detected.length).toBeGreaterThan(0);
    for (const signal of detected) expect(signal.evidence).toBeTruthy();
    expect(detected.some((s) => s.key === 'paying_for_traffic' && s.sourceUrl !== null)).toBe(true);

    // --- scored, qualified, and visible as a lead --------------------------
    const promoted = await h.db.select().from(companies);
    expect(promoted.some((c) => c.enrichedAt !== null)).toBe(true);
    expect(promoted.some((c) => (c.serviceAreas as string[]).length > 0)).toBe(true);
    expect(promoted.some((c) => (c.services as string[]).length > 0)).toBe(true);
    expect(promoted.some((c) => c.researchSummary !== null)).toBe(true);

    const scored = await h.db.select().from(contacts);
    expect(scored.every((c) => c.score !== null)).toBe(true);

    const outcome = await searchOutcome(h.ctx, search.id);
    expect(outcome.leads).toBe(records.filter((r) => r.companyId !== null).length);
    expect(outcome.averageScore).toBeGreaterThan(0);
    expect(outcome.qualified).toBeGreaterThan(0);

    const leads = await listLeads(h.ctx, { filters: { view: 'CALL_READY' } });
    expect(leads.total).toBeGreaterThan(0);

    // --- the provenance trail the admin panel renders ----------------------
    const detail = await getLeadDetail(h.ctx, leads.rows[0]!.contactId);
    expect(detail.discovery?.provider).toBe('mock');
    expect(detail.discovery?.sourceUrl).toBeTruthy();
    expect(detail.discovery?.crawlStatus).toBe('OK');
    expect(detail.enrichment.length).toBeGreaterThan(0);
    expect(detail.signals.some((s) => s.sourceUrl !== null)).toBe(true);
  }, 120_000);

  it('records a failed crawl and keeps going', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 40,
      filters: { requirePhone: true, requireWebsite: true },
    });
    await startSearchJob(h.ctx, search.id);
    // Some of the synthetic businesses have no working site, exactly as some
    // real ones do — enough of them that a batch of 40 reliably hits both.
    await drain();

    const job = await getSearchJob(h.ctx, search.id);
    expect(job.crawledCount).toBeGreaterThan(0);
    expect(job.crawlFailedCount).toBeGreaterThan(0);
    // A dead website is a finding about the business, not a failed run.
    expect(job.status).toBe('COMPLETED');
    expect(job.failedCount).toBe(0);

    const records = await h.db.select().from(leadDiscoveryRecords);
    const failed = records.filter((r) => r.crawlStatus === 'FAILED');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.crawlError).toMatch(/FETCH_FAILED|TIMEOUT|NO_PAGES/);
    // The lead still progressed past the crawl.
    expect(failed[0]!.companyId).toBeTruthy();
    const stillScored = await h.db.select().from(contacts).where(eq(contacts.id, failed[0]!.contactId!));
    expect(stillScored[0]!.score).not.toBeNull();
  }, 120_000);

  it('resumes a run rather than restarting it', async () => {
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 5,
      filters: { requirePhone: true, requireWebsite: true },
    });
    await startSearchJob(h.ctx, search.id);

    // One tick only: discovery runs, most enrichment does not.
    await tick({ sendBatch: 0, sequenceBatch: 0, aiBatch: 0, leadBatch: 1, skipMaintenance: true });
    const partway = await getSearchJob(h.ctx, search.id);
    expect(partway.discoveredCount).toBeGreaterThan(0);
    expect(partway.status).not.toBe('COMPLETED');

    const recordsBefore = await h.db.select().from(leadDiscoveryRecords);

    // Resuming picks up the remaining work without re-discovering.
    await drain();

    const recordsAfter = await h.db.select().from(leadDiscoveryRecords);
    expect(recordsAfter).toHaveLength(recordsBefore.length);
    expect(h.discovery.searches).toHaveLength(1);
    expect((await getSearchJob(h.ctx, search.id)).status).toBe('COMPLETED');
  }, 120_000);

  it("keeps leads below the run's minimum score but does not put them up for review", async () => {
    const { leadPersonalization } = await import('@/lib/db/schema');

    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 5,
      // Nothing the synthetic provider produces scores this high.
      filters: { requirePhone: true, minScore: 99 },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    // The leads exist in full: discovered, promoted, scored.
    const records = await h.db.select().from(leadDiscoveryRecords);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.companyId !== null)).toBe(true);
    const scored = await h.db.select().from(contacts);
    expect(scored.every((c) => c.score !== null)).toBe(true);

    // They are simply not queued for review, and cost no AI call for copy.
    expect(records.every((r) => r.stage !== 'REVIEW')).toBe(true);
    expect(await h.db.select().from(leadPersonalization)).toHaveLength(0);
    expect((await listLeads(h.ctx, { filters: { view: 'REVIEW' } })).total).toBe(0);

    // And they are not callable or campaign-ready either. The queue builds from
    // READY, so readiness is the only place that can hold this line.
    expect(scored.every((c) => c.callReadiness !== 'READY')).toBe(true);
    expect((await listLeads(h.ctx, { filters: { view: 'CALL_READY' } })).total).toBe(0);
    expect((await listLeads(h.ctx, { filters: { view: 'CAMPAIGN_READY' } })).total).toBe(0);

    const { createCallQueue } = await import('@/lib/services/call-queue');
    const queue = await createCallQueue(h.ctx, { name: 'Below the bar', filters: {} });
    expect(queue.totalCount).toBe(0);

    // Approving one by hand does not smuggle it past the gate either.
    const { approveLeads } = await import('@/lib/services/leads');
    await approveLeads(h.ctx, [scored[0]!.id]);
    const afterApproval = (await h.db.select().from(contacts).where(eq(contacts.id, scored[0]!.id)))[0]!;
    expect(afterApproval.callReadiness).not.toBe('READY');
  }, 120_000);

  it('completes a search that matched nothing without failing it', async () => {
    h.discovery.emptyNext = true;
    const search = await createSearchJob(h.ctx, {
      query: 'submarine repair',
      location: 'Saskatoon, SK',
      requestedCount: 10,
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const job = await getSearchJob(h.ctx, search.id);
    expect(job.status).toBe('COMPLETED');
    expect(job.discoveredCount).toBe(0);
    expect(job.error).toBeNull();
    expect(await h.db.select().from(companies)).toHaveLength(0);
  }, 60_000);

  it('marks the run failed when the provider does, with the provider reason', async () => {
    h.discovery.failNext = true;
    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 5,
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const job = await getSearchJob(h.ctx, search.id);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/Mock discovery failure/);
    // A provider outage creates no half-built leads.
    expect(await h.db.select().from(companies)).toHaveLength(0);
  }, 60_000);
});

describe('deduplication before a lead is created', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('matches on place id, phone, domain and name+address — strongest first', async () => {
    const { createProspect } = await import('@/lib/services/contacts');
    const { findDuplicate } = await import('@/lib/lead-generation/dedupe');
    const { normalizeBusinessName, normalizeWebsite } = await import('@/lib/lead-generation/normalize');

    const existing = await createProspect(h.ctx, {
      phone: '9055550143',
      company: {
        name: 'Summit Roofing Inc.',
        website: 'https://summit-roofing.example',
        city: 'Mississauga',
        province: 'ON',
        industry: 'Roofing',
      },
    });
    const { companies: companiesTable } = await import('@/lib/db/schema');
    await h.db
      .update(companiesTable)
      .set({
        externalId: 'places_abc',
        addressLine: '120 Lakeshore Rd, Mississauga, ON',
        nameKey: normalizeBusinessName('Summit Roofing Inc.'),
        websiteDomain: normalizeWebsite('https://summit-roofing.example')!.domain,
      })
      .where(eq(companiesTable.id, existing.companyId!));

    const base = {
      businessName: 'Summit Roofing',
      nameKey: normalizeBusinessName('Summit Roofing'),
      phone: null,
      phoneRaw: null,
      phoneValid: false,
      email: null,
      website: null,
      websiteDomain: null,
      addressLine: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'Canada',
      category: null,
      categories: [],
      rating: null,
      reviewCount: null,
      latitude: null,
      longitude: null,
      hours: null,
      socialUrls: {},
      sourceUrl: null,
      externalId: null,
    };

    // Same provider id — the strongest possible match.
    const byId = await findDuplicate(h.ctx, { ...base, externalId: 'places_abc' });
    expect(byId.isDuplicate).toBe(true);
    expect(byId.reason).toBe('place_id');

    // Same number, written differently.
    const byPhone = await findDuplicate(h.ctx, { ...base, phone: '+19055550143', phoneValid: true });
    expect(byPhone.isDuplicate).toBe(true);
    expect(byPhone.reason).toBe('phone');

    // Same site, with tracking junk and a www.
    const byDomain = await findDuplicate(h.ctx, {
      ...base,
      website: 'https://www.summit-roofing.example/?utm_source=maps',
      websiteDomain: normalizeWebsite('https://www.summit-roofing.example/?utm_source=maps')!.domain,
    });
    expect(byDomain.isDuplicate).toBe(true);
    expect(byDomain.reason).toBe('website_domain');

    // Same business, same street, name written slightly differently.
    const byName = await findDuplicate(h.ctx, {
      ...base,
      businessName: 'Summit Roofing Incorporated',
      nameKey: normalizeBusinessName('Summit Roofing Incorporated'),
      addressLine: '120 Lakeshore Road, Mississauga, ON',
      city: 'Mississauga',
    });
    expect(byName.isDuplicate).toBe(true);
    expect(byName.reason).toBe('name_and_address');

    // A different business is not a duplicate of it.
    const other = await findDuplicate(h.ctx, {
      ...base,
      businessName: 'Northgate Plumbing',
      nameKey: normalizeBusinessName('Northgate Plumbing'),
      phone: '+16475550100',
      phoneValid: true,
    });
    expect(other.isDuplicate).toBe(false);
  }, 60_000);

  it('never creates a second record for a business that appears in two searches', async () => {
    for (const _run of [1, 2]) {
      const search = await createSearchJob(h.ctx, {
        query: 'roofing',
        location: 'Mississauga, ON',
        requestedCount: 5,
        filters: { requirePhone: true },
      });
      await startSearchJob(h.ctx, search.id);
      await drain();
    }

    // Same provider, same business: recognised by the unique index on
    // (organization, provider, external id), so the second run does not even
    // create a discovery record to deduplicate later.
    const promoted = await h.db.select().from(companies);
    const externalIds = promoted.map((c) => c.externalId);
    expect(new Set(externalIds).size).toBe(externalIds.length);

    const records = await h.db.select().from(leadDiscoveryRecords);
    expect(new Set(records.map((r) => r.externalId)).size).toBe(records.length);
    expect(records.filter((r) => r.companyId !== null).length).toBe(promoted.length);
  }, 120_000);

  it('recognises the same business rediscovered under a new provider id', async () => {
    const { duplicateMatches } = await import('@/lib/db/schema');
    const { runNormalization } = await import('@/lib/services/lead-pipeline');

    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 4,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const first = (await h.db.select().from(leadDiscoveryRecords))[0]!;
    const companyCountBefore = (await h.db.select().from(companies)).length;

    // The same business, listed again under a different id — a re-listing, or
    // the same place returned by a second source.
    const [again] = await h.db
      .insert(leadDiscoveryRecords)
      .values({
        organizationId: h.ctx.organizationId,
        searchJobId: search.id,
        provider: 'mock',
        externalId: 'mock_relisted_under_a_new_id',
        stage: 'DISCOVERED',
        businessName: `${first.businessName} Ltd`,
        nameKey: first.nameKey,
        phone: first.phone,
        phoneRaw: first.phoneRaw,
        city: first.city,
        province: first.province,
        addressLine: first.addressLine,
      })
      .returning();

    const outcome = await runNormalization({
      id: 'test',
      organizationId: h.ctx.organizationId,
      type: 'lead_normalization',
      searchJobId: search.id,
      discoveryRecordId: again!.id,
      companyId: null,
      contactId: null,
      payload: {},
      attempts: 1,
      maxAttempts: 3,
    });

    expect(outcome.result).toBe('ok');
    expect((await h.db.select().from(companies)).length).toBe(companyCountBefore);

    const updated = (
      await h.db.select().from(leadDiscoveryRecords).where(eq(leadDiscoveryRecords.id, again!.id))
    )[0]!;
    expect(updated.stage).toBe('DUPLICATE');
    expect(updated.duplicateReason).toBe('phone');
    expect(updated.duplicateOfCompanyId).toBe(first.companyId);

    // Recorded with its evidence rather than deleted.
    const matches = await h.db.select().from(duplicateMatches);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.score).toBeGreaterThan(0.9);
  }, 120_000);
});

describe('suppressed and invalid numbers', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('promotes a suppressed number as do-not-contact rather than as a callable lead', async () => {
    const { suppress } = await import('@/lib/services/suppression');

    // Suppress a number before the search that will discover it.
    const preview = await h.discovery.searchBusinesses({
      query: 'roofing',
      location: 'Mississauga, ON',
      radiusMeters: 25_000,
      limit: 5,
      filters: { requirePhone: true },
    });
    const target = preview.businesses.find((b) => b.phone)!;
    await suppress(h.ctx, { phone: target.phone!, reason: 'MANUAL' });

    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 5,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const rows = await h.db.select().from(contacts).where(eq(contacts.phone, target.phone!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('DO_NOT_CONTACT');
    // Discovered and recorded, but never call-ready.
    expect(rows[0]!.callReadiness).not.toBe('READY');
  }, 120_000);

  it('keeps a wrong number out of every future queue', async () => {
    const { recordDisposition } = await import('@/lib/services/calls');
    const { createCallQueue } = await import('@/lib/services/call-queue');
    const { callQueueItems } = await import('@/lib/db/schema');

    const search = await createSearchJob(h.ctx, {
      query: 'roofing',
      location: 'Mississauga, ON',
      requestedCount: 6,
      filters: { requirePhone: true },
    });
    await startSearchJob(h.ctx, search.id);
    await drain();

    const { approveLeads } = await import('@/lib/services/leads');
    const all = await listLeads(h.ctx);
    await approveLeads(h.ctx, all.rows.map((r) => r.contactId));

    const ready = await listLeads(h.ctx, { filters: { view: 'CALL_READY' } });
    const target = ready.rows[0]!;

    await recordDisposition(h.ctx, { contactId: target.contactId, outcome: 'WRONG_NUMBER' });

    const after = (await h.db.select().from(contacts).where(eq(contacts.id, target.contactId)))[0]!;
    // The disposition update must persist — this regressed once before.
    expect(after.phoneInvalid).toBe(true);
    expect(after.phoneValidated).toBe(false);
    expect(after.status).toBe('DO_NOT_CONTACT');

    const queue = await createCallQueue(h.ctx, { name: 'After wrong number', filters: {} });
    const items = await h.db.select().from(callQueueItems).where(eq(callQueueItems.queueId, queue.id));
    expect(items.map((i) => i.contactId)).not.toContain(target.contactId);
    expect(items.length).toBe(ready.rows.length - 1);
  }, 120_000);
});

describe('the synthetic web', () => {
  it('serves only the reserved .example TLD, and refuses anything real', async () => {
    const { syntheticFetch } = await import('@/lib/lead-generation/providers/mock-web');

    const ok = await syntheticFetch('https://summit-roofing.example/');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Summit Roofing');

    // The safety property: it cannot stand in front of a real request.
    await expect(syntheticFetch('https://google.com/')).rejects.toThrow(/reserved \.example/);
    await expect(syntheticFetch('https://acme.co.uk/')).rejects.toThrow(/reserved \.example/);
    await expect(syntheticFetch('https://not-example.com/')).rejects.toThrow(/reserved \.example/);
  });

  it('is deterministic per host and varied across hosts', async () => {
    const { syntheticFetch } = await import('@/lib/lead-generation/providers/mock-web');

    const once = await (await syntheticFetch('https://alpha-roofing.example/')).text();
    const twice = await (await syntheticFetch('https://alpha-roofing.example/')).text();
    expect(once).toBe(twice);

    // Across many hosts the profiles differ, so signal detection has both
    // positives and negatives to find rather than one uniform site.
    const viewports = await Promise.all(
      Array.from({ length: 24 }, async (_, i) => {
        try {
          const html = await (await syntheticFetch(`https://firm-${i}-roofing.example/`)).text();
          return html.includes('name="viewport"');
        } catch {
          return null; // a dead site, which is also a real outcome
        }
      }),
    );
    expect(viewports.some((v) => v === true)).toBe(true);
    expect(viewports.some((v) => v === false || v === null)).toBe(true);
  });
});

describe('contact enrichment', () => {
  it('prefers a real mailbox on the business own domain', async () => {
    const { pickBestEmail } = await import('@/lib/services/contact-enrichment');

    // Their domain beats a free mailbox.
    expect(pickBestEmail(['acme@gmail.com', 'info@acme.example'], 'acme.example')).toBe('info@acme.example');
    // A named mailbox beats a generic one when neither is on their domain.
    expect(pickBestEmail(['admin@x.example', 'info@x.example'], 'acme.example')).toBe('info@x.example');
    // Platform noise is never a business contact.
    expect(pickBestEmail(['bugs@sentry.io'], 'acme.example')).toBeNull();
    expect(pickBestEmail([], 'acme.example')).toBeNull();
  });

  it('adds what the site published without overwriting what a human entered', async () => {
    const h = await createHarness();
    try {
      const { enrichContact } = await import('@/lib/services/contact-enrichment');
      const { createProspect } = await import('@/lib/services/contacts');
      const { leadEnrichment, companies: companiesTable } = await import('@/lib/db/schema');

      const prospect = await createProspect(h.ctx, {
        phone: '9055550143',
        email: 'typed-by-a-human@acme.example',
        company: { name: 'Acme Roofing', city: 'Mississauga', industry: 'Roofing' },
      });
      await h.db
        .update(companiesTable)
        .set({ website: 'https://acme.example', websiteDomain: 'acme.example', ownerName: 'Dana Fitzgerald' })
        .where(eq(companiesTable.id, prospect.companyId!));

      await h.db.insert(leadEnrichment).values({
        organizationId: h.ctx.organizationId,
        companyId: prospect.companyId!,
        kind: 'website',
        ok: true,
        input: {},
        output: {
          emails: ['info@acme.example'],
          phones: ['+19055550143'],
          pages: [{ url: 'https://acme.example/contact', role: 'contact' }],
        },
      });

      const outcome = await enrichContact(h.ctx, prospect.id);
      expect(outcome.result).toBe('enriched');

      const after = (await h.db.select().from(contacts).where(eq(contacts.id, prospect.id)))[0]!;
      // The typed address survives — scraping never overwrites a human.
      expect(after.email).toBe('typed-by-a-human@acme.example');
      // The provider's number is published on their own site: two sources agree.
      expect(after.phoneConfidence).toBe(0.95);
      expect(after.firstName).toBe('Dana');
      expect(after.lastName).toBe('Fitzgerald');

      const signals = await h.db.select().from(leadSignals);
      const corroborated = signals.find((s) => s.key === 'phone_corroborated')!;
      expect(corroborated.detected).toBe(true);
      expect(corroborated.sourceUrl).toBe('https://acme.example/contact');
    } finally {
      await h.close();
    }
  }, 60_000);

  it('records a number that differs from the listing rather than replacing it', async () => {
    const h = await createHarness();
    try {
      const { enrichContact } = await import('@/lib/services/contact-enrichment');
      const { createProspect } = await import('@/lib/services/contacts');
      const { leadEnrichment, companies: companiesTable } = await import('@/lib/db/schema');

      const prospect = await createProspect(h.ctx, {
        phone: '9055550143',
        company: { name: 'Beta Roofing', city: 'Mississauga', industry: 'Roofing' },
      });
      await h.db
        .update(companiesTable)
        .set({ website: 'https://beta.example', websiteDomain: 'beta.example' })
        .where(eq(companiesTable.id, prospect.companyId!));

      await h.db.insert(leadEnrichment).values({
        organizationId: h.ctx.organizationId,
        companyId: prospect.companyId!,
        kind: 'website',
        ok: true,
        input: {},
        output: {
          emails: [],
          phones: ['+16475550199'],
          pages: [{ url: 'https://beta.example/', role: 'home' }],
        },
      });

      await enrichContact(h.ctx, prospect.id);

      const after = (await h.db.select().from(contacts).where(eq(contacts.id, prospect.id)))[0]!;
      // The listed number stays. A different number on the site may be a
      // tracking line or a second desk — a finding, not a correction.
      expect(after.phone).toBe('+19055550143');
      const signals = await h.db.select().from(leadSignals);
      expect(signals.find((s) => s.key === 'alternate_phone_on_site')?.value).toBe('+16475550199');
    } finally {
      await h.close();
    }
  }, 60_000);
});

describe('provider configuration', () => {
  it('refuses to substitute synthetic data for a provider that is selected but unconfigured', async () => {
    const { discoveryProviderStatus, setDiscoveryProvider } = await import('@/lib/lead-generation/providers');
    installTestEnv();
    setDiscoveryProvider(undefined);

    const previous = process.env.LEAD_DISCOVERY_PROVIDER;
    const previousKey = process.env.GOOGLE_PLACES_API_KEY;
    try {
      process.env.LEAD_DISCOVERY_PROVIDER = 'google_places';
      delete process.env.GOOGLE_PLACES_API_KEY;
      const { resetEnvCache } = await import("@/lib/env");
      resetEnvCache();

      const status = discoveryProviderStatus();
      expect(status.ok).toBe(false);
      if (status.ok) throw new Error('unreachable');
      expect(status.code).toBe('NOT_CONFIGURED');
      // The message names the variable and the way out.
      expect(status.error).toContain('GOOGLE_PLACES_API_KEY');
      expect(status.error).toContain('LEAD_DISCOVERY_PROVIDER=mock');
    } finally {
      if (previous === undefined) delete process.env.LEAD_DISCOVERY_PROVIDER;
      else process.env.LEAD_DISCOVERY_PROVIDER = previous;
      if (previousKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
      else process.env.GOOGLE_PLACES_API_KEY = previousKey;
      const { resetEnvCache } = await import("@/lib/env");
      resetEnvCache();
      setDiscoveryProvider(undefined);
    }
  });
});
