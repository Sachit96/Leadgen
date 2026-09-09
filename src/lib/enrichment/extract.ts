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

export type ExtractedSite = {
  title: string | null;
  description: string | null;
  text: string;
  emails: string[];
  phones: string[];
  socialUrls: Record<string, string>;
  services: string[];
  bookingLinks: string[];
};

const BOOKING_HOSTS = [
  'calendly.com', 'acuityscheduling.com', 'squareup.com/appointments', 'setmore.com',
  'housecallpro.com', 'jobber.com', 'servicetitan.com', 'book.', 'booking.',
  'schedule.', 'appointments.', 'cal.com',
];

export function extractSite(pages: CrawlPage[]): ExtractedSite {
  const home = pages.find((p) => p.path === '/') ?? pages[0];
  const combinedHtml = pages.map((p) => p.html).join('\n');
  const text = pages.map((p) => htmlToText(p.html)).join('\n').slice(0, 200_000);

  const bookingLinks: string[] = [];
  for (const match of combinedHtml.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = match[1]!;
    if (BOOKING_HOSTS.some((host) => url.toLowerCase().includes(host))) {
      const normalized = normalizeWebsite(url);
      if (normalized && !bookingLinks.includes(normalized.url)) bookingLinks.push(normalized.url);
    }
  }

  return {
    title: home ? pageTitle(home.html) : null,
    description: home ? (metaContent(home.html, 'description') ?? metaContent(home.html, 'og:description')) : null,
    text,
    emails: extractEmails(combinedHtml, text),
    phones: extractPhones(combinedHtml, text),
    socialUrls: extractSocialUrls(combinedHtml),
    services: extractServices(text),
    bookingLinks: bookingLinks.slice(0, 5),
  };
}
