import { normalizeEmail, normalizePhone } from '@/lib/core/phone';
import { normalizeWebsite } from '@/lib/lead-generation/normalize';
import type { CrawlPage } from './crawler';

/**
 * Extraction from fetched HTML.
 *
 * Regex-based rather than a DOM parser: the inputs are hostile (arbitrary
 * third-party markup), we only need a handful of well-known patterns, and this
 * avoids pulling a parser into the worker. Everything extracted is treated as
 * untrusted text — it is never executed, never interpolated into HTML, and
 * where it reaches the model it goes inside an explicitly delimited block.
 */

/** Strips scripts, styles and tags, leaving readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function metaContent(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]+property=["']og:${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return null;
}

export function pageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1].replace(/\s+/g, ' ').trim()) : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

const SOCIAL_HOSTS: Record<string, string> = {
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'instagram.com': 'instagram',
  'linkedin.com': 'linkedin',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'youtube.com': 'youtube',
  'tiktok.com': 'tiktok',
};

/** Public social profiles linked from the site. No login-required scraping. */
export function extractSocialUrls(html: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const raw = match[1]!;
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    for (const [needle, network] of Object.entries(SOCIAL_HOSTS)) {
      if (host !== needle && !host.endsWith(`.${needle}`)) continue;
      // Skip share/intent links — they are not the business's profile.
      if (/\/(sharer|share|intent|dialog)\b/i.test(raw)) continue;
      if (!found[network]) found[network] = raw.split('?')[0]!;
    }
  }
  return found;
}

export function extractEmails(html: string, text: string): string[] {
  const emails = new Set<string>();

  for (const match of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    const email = normalizeEmail(decodeURIComponent(match[1]!));
    if (email) emails.add(email);
  }
  for (const match of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
    const email = normalizeEmail(match[0]);
    if (email) emails.add(email);
  }

  // Image and asset filenames routinely look like addresses.
  return [...emails].filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(e));
}

export function extractPhones(html: string, text: string): string[] {
  const phones = new Set<string>();

  for (const match of html.matchAll(/tel:([+\d\s().-]{7,})/gi)) {
    const phone = normalizePhone(match[1]!, 'CA');
    if (phone.valid && phone.e164) phones.add(phone.e164);
  }
  for (const match of text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) {
    const phone = normalizePhone(match[0], 'CA');
    if (phone.valid && phone.e164) phones.add(phone.e164);
  }
  return [...phones];
}

const SERVICE_HINTS = [
  'roof replacement', 'roof repair', 'shingle', 'flat roof', 'metal roof', 'eavestrough', 'siding',
  'gutter', 'skylight', 'attic', 'insulation', 'furnace', 'air conditioning', 'heat pump',
  'ductwork', 'water heater', 'drain', 'plumbing repair', 'emergency service', 'landscaping',
  'hardscape', 'lawn care', 'snow removal', 'interlock', 'window replacement', 'kitchen remodel',
  'bathroom renovation', 'painting', 'deck', 'fence',
];

/** Services mentioned on the site, as evidence rather than inference. */
export function extractServices(text: string): string[] {
  const lower = text.toLowerCase();
  return SERVICE_HINTS.filter((hint) => lower.includes(hint));
}


/** Visible headings, in document order — the site's own outline of itself. */
export function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  for (const match of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]{0,400}?)<\/h\1>/gi)) {
    const text = htmlToText(match[2]!);
    if (text && text.length <= 200 && !headings.includes(text)) headings.push(text);
    if (headings.length >= 40) break;
  }
  return headings;
}

/** One or two capitalized words, joined by commas or "and" — how a site writes a list of towns. */
const PLACE = String.raw`[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?`;
const PLACE_LIST = String.raw`(${PLACE}(?:\s*(?:,|,?\s*and)\s*${PLACE}){0,14})`;

const SERVICE_AREA_PATTERNS = [
  new RegExp(String.raw`(?:proudly\s+)?serving\s+${PLACE_LIST}`, 'g'),
  new RegExp(String.raw`service\s+areas?\s*:?\s*${PLACE_LIST}`, 'gi'),
  new RegExp(String.raw`areas?\s+we\s+serve\s*:?\s*${PLACE_LIST}`, 'gi'),
];

/**
 * Areas the business says it serves.
 *
 * Read from the site's own words ("serving Mississauga, Oakville and
 * Burlington") rather than inferred from the address, because a contractor's
 * service area is often several times the size of the city they are listed in —
 * and that gap is a sales signal.
 */
export function extractServiceAreas(text: string): string[] {
  const areas = new Set<string>();

  for (const pattern of SERVICE_AREA_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      for (const part of match[1]!.split(/\s*,\s*|\s+and\s+/)) {
        // Keep only the leading run of capitalized words: "Burlington since
        // 1998" is a place name with the rest of the sentence attached.
        const words: string[] = [];
        for (const word of part.trim().split(/\s+/)) {
          if (!/^[A-Z][\w'-]*$/.test(word)) break;
          words.push(word);
        }
        const area = words.join(' ').replace(/[.;:]$/, '');
        if (area.length >= 3 && area.length <= 40 && words.length > 0 && words.length <= 2) areas.add(area);
      }
    }
  }
  return [...areas].slice(0, 25);
}

/** Emergency / same-day availability, which changes both urgency and job value. */
export function mentionsEmergencyService(text: string): string | null {
  const match =
    /(24[\s/-]?7|24\s*hours?|emergency\s+(service|repair|response|call)|same[\s-]day|after[\s-]hours)/i.exec(text);
  return match ? match[0] : null;
}

/**
 * A short description of the business in its own words.
 *
 * Prefers the meta description, then the first substantial sentence of the
 * homepage — both are the business describing itself, which is what the
 * research agent should be reasoning over.
 */
export function extractDescription(description: string | null, text: string): string | null {
  if (description && description.trim().length >= 40) return description.trim().slice(0, 400);
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const trimmed = sentence.trim();
    if (trimmed.length >= 60 && trimmed.length <= 400) return trimmed;
  }
  return description?.trim() || null;
}

/**
 * One page, normalized for storage and for the model.
 *
 * This is the unit the research agent reads. It keeps the page's identity (url,
 * role) attached to its text, so the agent can attribute a fact to a page and
 * an operator can open that page and check.
 */
export type ExtractedPage = {
  url: string;
  path: string;
  role: string;
  title: string | null;
  headings: string[];
  text: string;
  bytes: number;
};

export function extractPage(page: CrawlPage, maxChars: number): ExtractedPage {
  return {
    url: page.url,
    path: page.path,
    role: page.role,
    title: pageTitle(page.html),
    headings: extractHeadings(page.html),
    text: htmlToText(page.html).slice(0, maxChars),
    bytes: page.bytes,
  };
}

/** Per page, so the agent sees every page rather than the top of a long homepage. */
export const PER_PAGE_TEXT_LIMIT = 6_000;

export type ExtractedSite = {
  title: string | null;
  description: string | null;
  text: string;
  emails: string[];
  phones: string[];
  socialUrls: Record<string, string>;
  services: string[];
  bookingLinks: string[];
  /** Per-page normalized content — what the research agent actually reads. */
  pages: ExtractedPage[];
  headings: string[];
  serviceAreas: string[];
  emergencyMention: string | null;
};

/** Third-party scheduling products, matched on the host itself. */
const BOOKING_HOSTS = [
  'calendly.com', 'acuityscheduling.com', 'setmore.com', 'cal.com',
  'housecallpro.com', 'jobber.com', 'getjobber.com', 'servicetitan.com', 'squareup.com',
];

/**
 * Subdomains businesses put a booking flow on.
 *
 * Matched against the first label of the hostname, never as a substring of the
 * whole URL: `book.` appears inside `facebook.com`, and treating a link to a
 * Facebook page as an online booking system marks a business as having
 * conversion infrastructure it does not have.
 */
const BOOKING_SUBDOMAINS = ['book', 'booking', 'schedule', 'scheduling', 'appointments'];

function isBookingLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (BOOKING_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) {
    // Square hosts far more than appointments; require the booking path.
    if (host.endsWith('squareup.com')) return parsed.pathname.startsWith('/appointments');
    return true;
  }
  return BOOKING_SUBDOMAINS.includes(host.split('.')[0] ?? '');
}

export function extractSite(pages: CrawlPage[]): ExtractedSite {
  const home = pages.find((p) => p.path === '/') ?? pages[0];
  const combinedHtml = pages.map((p) => p.html).join('\n');
  const text = pages.map((p) => htmlToText(p.html)).join('\n').slice(0, 200_000);

  const bookingLinks: string[] = [];
  for (const match of combinedHtml.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = match[1]!;
    if (isBookingLink(url)) {
      const normalized = normalizeWebsite(url);
      if (normalized && !bookingLinks.includes(normalized.url)) bookingLinks.push(normalized.url);
    }
  }

  const metaDescription = home
    ? (metaContent(home.html, 'description') ?? metaContent(home.html, 'og:description'))
    : null;

  return {
    title: home ? pageTitle(home.html) : null,
    description: extractDescription(metaDescription, text),
    text,
    emails: extractEmails(combinedHtml, text),
    phones: extractPhones(combinedHtml, text),
    socialUrls: extractSocialUrls(combinedHtml),
    services: extractServices(text),
    bookingLinks: bookingLinks.slice(0, 5),
    // Budgeted per page rather than one truncated blob, so a services page is
    // never lost behind a long homepage.
    pages: pages.map((page) => extractPage(page, PER_PAGE_TEXT_LIMIT)),
    headings: home ? extractHeadings(home.html) : [],
    serviceAreas: extractServiceAreas(text),
    emergencyMention: mentionsEmergencyService(text),
  };
}
