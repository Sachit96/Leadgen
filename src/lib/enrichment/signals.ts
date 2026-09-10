import type { CrawlPage } from './crawler';
import type { ExtractedSite } from './extract';

/**
 * Technology and conversion signal detection.
 *
 * Every signal carries the exact evidence that produced it — the script src,
 * the matched attribute, the URL. That is a product requirement, not
 * bookkeeping: the AI is allowed to say "they're running paid advertising" only
 * because a Google Ads tag was found on a named page, and the operator can see
 * which one. Absence of evidence is recorded as `detected: false`, never as a
 * claim about the business.
 */
export type Signal = {
  key: string;
  category: 'advertising' | 'analytics' | 'booking' | 'crm' | 'conversion' | 'quality' | 'social';
  detected: boolean;
  value?: string | null;
  confidence: number;
  /** What was actually found. Null when the signal was not detected. */
  evidence: string | null;
  source: string;
  /** The page the evidence came from, so a claim can be checked. */
  sourceUrl: string | null;
  /** True when this is a judgement rather than a direct observation. */
  inferred: boolean;
};

type Matcher = {
  key: string;
  category: Signal['category'];
  /** Patterns searched in raw HTML. */
  patterns: RegExp[];
  label?: string;
  confidence?: number;
};

const TECH_MATCHERS: Matcher[] = [
  {
    key: 'google_ads',
    category: 'advertising',
    patterns: [
      /googleadservices\.com\/pagead\/conversion/i,
      /gtag\(\s*['"]config['"]\s*,\s*['"]AW-\d+/i,
      /googletagmanager\.com\/gtag\/js\?id=AW-/i,
    ],
    label: 'Google Ads conversion tag',
  },
  {
    key: 'meta_pixel',
    category: 'advertising',
    patterns: [/connect\.facebook\.net\/[^"']*\/fbevents\.js/i, /fbq\(\s*['"]init['"]/i],
    label: 'Meta Pixel',
  },
  {
    key: 'google_analytics',
    category: 'analytics',
    patterns: [/googletagmanager\.com\/gtag\/js\?id=G-/i, /google-analytics\.com\/analytics\.js/i],
    label: 'Google Analytics',
  },
  {
    key: 'google_tag_manager',
    category: 'analytics',
    patterns: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]{4,}/],
    label: 'Google Tag Manager',
  },
  {
    key: 'chat_widget',
    category: 'conversion',
    patterns: [
      /tawk\.to/i, /intercom\.io/i, /drift\.com/i, /crisp\.chat/i,
      /livechatinc\.com/i, /tidio/i, /podium\.com/i,
    ],
    label: 'Live chat widget',
  },
  {
    key: 'online_booking',
    category: 'booking',
    patterns: [
      /calendly\.com/i, /acuityscheduling\.com/i, /setmore\.com/i,
      /cal\.com/i, /squareup\.com\/appointments/i,
    ],
    label: 'Online booking',
  },
  {
    key: 'field_service_crm',
    category: 'crm',
    patterns: [
      /housecallpro\.com/i, /getjobber\.com|jobber\.com/i, /servicetitan\.com/i,
      /jobnimbus\.com/i, /acculynx\.com/i, /workiz\.com/i,
    ],
    label: 'Field-service CRM',
  },
  {
    key: 'marketing_crm',
    category: 'crm',
    patterns: [/hubspot\.com|hs-scripts\.com/i, /salesforce\.com/i, /activecampaign\.com/i],
    label: 'Marketing CRM',
  },
  {
    key: 'review_widget',
    category: 'social',
    patterns: [/birdeye/i, /podium\.com\/widget/i, /trustpilot\.com\/bootstrap/i, /elfsight.*review/i],
    label: 'Review widget',
  },
];

type Evidence = { text: string; url: string | null };

/** Finds the first match across the crawled pages, and says which page it was on. */
function findEvidence(pages: CrawlPage[], patterns: RegExp[]): Evidence | null {
  for (const page of pages) {
    for (const pattern of patterns) {
      const match = pattern.exec(page.html);
      if (!match) continue;
      // Keep a short window around the hit, so the operator sees context.
      const start = Math.max(0, match.index - 20);
      const text = page.html
        .slice(start, match.index + match[0].length + 40)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      return { text, url: page.url };
    }
  }
  return null;
}

export type QualityFlags = {
  has_ssl: boolean;
  has_mobile_viewport: boolean;
  has_contact_form: boolean;
  has_booking_flow: boolean;
  has_clear_cta: boolean;
  has_phone_visible: boolean;
  has_lead_form: boolean;
  has_chat_widget: boolean;
  has_online_booking: boolean;
  has_service_pages: boolean;
  website_load_success: boolean;
};

const CTA_PATTERNS = [
  /get\s+(a\s+)?(free\s+)?(quote|estimate)/i,
  /request\s+(a\s+)?(quote|estimate|callback)/i,
  /book\s+(now|online|a\s+(call|visit|consultation))/i,
  /schedule\s+(a\s+)?(call|visit|consultation|estimate)/i,
  /contact\s+us\s+today/i,
  /call\s+now/i,
];

export function detectSignals(
  pages: CrawlPage[],
  site: ExtractedSite,
  origin: string,
): { signals: Signal[]; quality: QualityFlags; qualityScore: number } {
  const html = pages.map((p) => p.html).join('\n');
  const homepage = pages.find((p) => p.path === '/');
  const signals: Signal[] = [];

  for (const matcher of TECH_MATCHERS) {
    const evidence = findEvidence(pages, matcher.patterns);
    signals.push({
      key: matcher.key,
      category: matcher.category,
      detected: Boolean(evidence),
      value: evidence ? (matcher.label ?? matcher.key) : null,
      confidence: evidence ? (matcher.confidence ?? 0.95) : 0.9,
      evidence: evidence?.text ?? null,
      sourceUrl: evidence?.url ?? null,
      source: 'website',
      inferred: false,
    });
  }

  const hasForm = /<form\b/i.test(html);
  const hasEmailInput = /<input[^>]+type=["']email["']/i.test(html);
  const hasTelLink = /href=["']tel:/i.test(html);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const ctaMatch = CTA_PATTERNS.find((pattern) => pattern.test(site.text));
  const bookingDetected =
    site.bookingLinks.length > 0 || signals.find((s) => s.key === 'online_booking')?.detected === true;

  const quality: QualityFlags = {
    has_ssl: origin.startsWith('https://'),
    has_mobile_viewport: hasViewport,
    has_contact_form: hasForm,
    has_booking_flow: bookingDetected,
    has_clear_cta: Boolean(ctaMatch),
    has_phone_visible: hasTelLink || site.phones.length > 0,
    has_lead_form: hasForm && hasEmailInput,
    has_chat_widget: signals.find((s) => s.key === 'chat_widget')?.detected === true,
    has_online_booking: bookingDetected,
    has_service_pages: pages.some((p) => p.path.includes('service')) || site.services.length > 0,
    website_load_success: Boolean(homepage),
  };

  for (const [key, value] of Object.entries(quality)) {
    signals.push({
      key,
      category: 'quality',
      detected: value,
      confidence: 1,
      evidence: value ? (qualityEvidence[key as keyof QualityFlags] ?? 'observed in fetched markup') : null,
      sourceUrl: value ? (homepage?.url ?? pages[0]?.url ?? null) : null,
      source: 'website',
      inferred: false,
    });
  }

  for (const [network, url] of Object.entries(site.socialUrls)) {
    signals.push({
      key: `social_${network}`,
      category: 'social',
      detected: true,
      value: url,
      confidence: 1,
      evidence: url,
      sourceUrl: homepage?.url ?? pages[0]?.url ?? null,
      source: 'website',
      inferred: false,
    });
  }

  signals.push(...opportunitySignals(pages, site, quality, signals));

  return { signals, quality, qualityScore: scoreWebsiteQuality(quality) };
}

/** Weighted 0-100. Versioned via WEBSITE_QUALITY_VERSION. */
export const WEBSITE_QUALITY_VERSION = 'wq.v1';

const QUALITY_WEIGHTS: Record<keyof QualityFlags, number> = {
  website_load_success: 15,
  has_ssl: 10,
  has_mobile_viewport: 10,
  has_phone_visible: 15,
  has_contact_form: 12,
  has_lead_form: 8,
  has_clear_cta: 12,
  has_service_pages: 8,
  has_booking_flow: 5,
  has_online_booking: 3,
  has_chat_widget: 2,
};

export function scoreWebsiteQuality(quality: QualityFlags): number {
  let score = 0;
  for (const [key, weight] of Object.entries(QUALITY_WEIGHTS)) {
    if (quality[key as keyof QualityFlags]) score += weight;
  }
  return Math.min(100, score);
}

/**
 * The core On Radar thesis, expressed as a signal: a business paying for
 * attention while lacking the machinery to convert it is the ideal prospect.
 */
export function hasWeakConversionInfrastructure(quality: QualityFlags, signals: Signal[]): boolean {
  const detected = (key: string) => signals.find((s) => s.key === key)?.detected === true;
  const hasCrm = detected('field_service_crm') || detected('marketing_crm');
  return !hasCrm && !quality.has_booking_flow && !quality.has_chat_widget;
}

export function hasAdvertisingEvidence(signals: Signal[]): boolean {
  return signals.some((s) => s.category === 'advertising' && s.detected);
}

/** Human-readable evidence for each quality flag, so a bare `true` is never the answer. */
const qualityEvidence: Partial<Record<keyof QualityFlags, string>> = {
  has_ssl: 'site served over https',
  has_mobile_viewport: '<meta name="viewport"> present',
  has_contact_form: '<form> element found',
  has_lead_form: 'form with an email input found',
  has_clear_cta: 'call-to-action wording found in page text',
  has_phone_visible: 'tel: link or phone number in page text',
  has_service_pages: 'a services page was crawled, or services named in the text',
  has_booking_flow: 'booking link or scheduling tag found',
  website_load_success: 'homepage fetched successfully',
};

/**
 * The signals a rep actually sells against.
 *
 * These are the qualification layer: not "what technology is on this site" but
 * "why is this business worth a call". Each one is a judgement drawn from
 * observations, so each is marked `inferred` and carries both the reasoning and
 * the page it was drawn from — a claim on the call screen must be checkable.
 *
 * Absence is never dressed up as a finding: a signal we could not establish is
 * `detected: false` with null evidence, which downstream means "no evidence",
 * not "the business lacks it".
 */
export function opportunitySignals(
  pages: CrawlPage[],
  site: ExtractedSite,
  quality: QualityFlags,
  technical: Signal[],
): Signal[] {
  const homeUrl = pages.find((p) => p.path === '/')?.url ?? pages[0]?.url ?? null;
  const detected = (key: string) => technical.find((s) => s.key === key)?.detected === true;
  const out: Signal[] = [];

  const add = (
    key: string,
    category: Signal['category'],
    hit: boolean,
    evidence: string | null,
    sourceUrl: string | null,
    confidence = 0.7,
    value?: string,
  ) => {
    out.push({
      key,
      category,
      detected: hit,
      value: hit ? (value ?? null) : null,
      confidence,
      evidence: hit ? evidence : null,
      sourceUrl: hit ? sourceUrl : null,
      source: 'derived',
      inferred: true,
    });
  };

  // --- the website is holding them back -----------------------------------
  const weakSite = quality.website_load_success && !quality.has_mobile_viewport;
  add(
    'outdated_website',
    'quality',
    weakSite,
    'no mobile viewport declared, so the site predates responsive design or was never adapted for phones',
    homeUrl,
    0.6,
    'no mobile viewport',
  );

  add(
    'missing_cta',
    'conversion',
    quality.website_load_success && !quality.has_clear_cta,
    'no quote, estimate, booking or "call now" wording found anywhere in the crawled pages',
    homeUrl,
    0.65,
    'no clear call to action',
  );

  add(
    'no_lead_form',
    'conversion',
    quality.website_load_success && !quality.has_lead_form,
    quality.has_contact_form
      ? 'a form exists but has no email field, so enquiries may not be capturable'
      : 'no form element on any crawled page',
    homeUrl,
    0.7,
    'no lead capture form',
  );

  add(
    'no_online_booking',
    'booking',
    quality.website_load_success && !quality.has_booking_flow,
    'no booking or scheduling link found on any crawled page',
    homeUrl,
    0.7,
    'no online booking or quote flow',
  );

  const contactPage = pages.find((p) => p.role === 'contact');
  add(
    'weak_contact_experience',
    'conversion',
    quality.website_load_success && !quality.has_phone_visible && !quality.has_contact_form,
    contactPage
      ? 'a contact page was crawled but carries no visible phone number and no form'
      : 'no contact page found, and no visible phone number or form on the pages crawled',
    contactPage?.url ?? homeUrl,
    0.75,
    'hard to contact',
  );

  add(
    'no_follow_up_mechanism',
    'crm',
    quality.website_load_success && !detected('field_service_crm') && !detected('marketing_crm') && !quality.has_chat_widget,
    'no CRM, marketing automation or chat tag found, so enquiries likely land in a personal inbox',
    homeUrl,
    0.55,
    'no visible follow-up system',
  );

  // --- they are worth calling ---------------------------------------------
  const adSignal = technical.find((s) => s.category === 'advertising' && s.detected);
  add(
    'paying_for_traffic',
    'advertising',
    Boolean(adSignal),
    adSignal ? `advertising tag found: ${adSignal.value ?? adSignal.key}` : null,
    adSignal?.sourceUrl ?? homeUrl,
    0.9,
    'running paid advertising',
  );

  // The thesis, stated as one signal: paying for attention, nothing to convert it.
  const weakConversion = hasWeakConversionInfrastructure(quality, technical);
  add(
    'weak_conversion_infrastructure',
    'conversion',
    weakConversion,
    `no CRM tag, booking flow or chat widget across ${pages.length} crawled page${pages.length === 1 ? '' : 's'}`,
    homeUrl,
    0.6,
    'no way to convert the traffic they get',
  );
  add(
    'spending_without_conversion',
    'conversion',
    Boolean(adSignal) && weakConversion,
    adSignal
      ? `advertising tag (${adSignal.value ?? adSignal.key}) with no CRM, booking flow or chat widget found`
      : null,
    adSignal?.sourceUrl ?? homeUrl,
    0.8,
    'paying for leads with nothing to catch them',
  );

  const servicesPage = pages.find((p) => p.role === 'services');
  add(
    'high_value_services',
    'quality',
    HIGH_VALUE_SERVICES.some((service) => site.services.includes(service)),
    `high-ticket work named on the site: ${site.services.filter((s) => HIGH_VALUE_SERVICES.includes(s)).join(', ')}`,
    servicesPage?.url ?? homeUrl,
    0.8,
    'sells high-ticket jobs',
  );

  const areaPage = pages.find((p) => p.role === 'service_area');
  add(
    'large_service_area',
    'quality',
    site.serviceAreas.length >= 5,
    `${site.serviceAreas.length} service areas named on the site: ${site.serviceAreas.slice(0, 8).join(', ')}`,
    areaPage?.url ?? homeUrl,
    0.7,
    `${site.serviceAreas.length} service areas`,
  );

  add(
    'emergency_services',
    'quality',
    Boolean(site.emergencyMention),
    site.emergencyMention ? `site advertises "${site.emergencyMention}"` : null,
    homeUrl,
    0.8,
    'emergency or same-day work',
  );

  return out;
}

/** Work where one extra booked job pays for the product several times over. */
const HIGH_VALUE_SERVICES = [
  'roof replacement', 'metal roof', 'flat roof', 'siding', 'window replacement',
  'kitchen remodel', 'bathroom renovation', 'heat pump', 'furnace', 'air conditioning',
  'insulation', 'interlock', 'hardscape', 'deck', 'fence',
];
