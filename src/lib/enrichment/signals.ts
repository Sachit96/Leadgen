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

function findEvidence(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      // Keep a short window around the hit, so the operator sees context.
      const start = Math.max(0, match.index - 20);
      return html.slice(start, match.index + match[0].length + 40).replace(/\s+/g, ' ').trim().slice(0, 160);
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
    const evidence = findEvidence(html, matcher.patterns);
    signals.push({
      key: matcher.key,
      category: matcher.category,
      detected: Boolean(evidence),
      value: evidence ? (matcher.label ?? matcher.key) : null,
      confidence: evidence ? (matcher.confidence ?? 0.95) : 0.9,
      evidence,
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
      evidence: value ? 'observed in fetched markup' : null,
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
      source: 'website',
      inferred: false,
    });
  }

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
