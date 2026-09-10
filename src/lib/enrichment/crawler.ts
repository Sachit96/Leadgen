import { createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/core/logger';
import { normalizeWebsite } from '@/lib/lead-generation/normalize';

/**
 * A deliberately small website crawler.
 *
 * This is not a spider. It fetches the homepage, reads the links the site's own
 * navigation offers, ranks them by how likely they are to answer a sales
 * question, and fetches the best few. It obeys robots.txt, caps bytes and time,
 * and never leaves the origin. The goal is to learn enough about one business
 * to qualify it honestly — not to index the web.
 *
 * Link discovery matters more than it sounds: a fixed path list finds `/about`
 * and misses `/our-team`, `/residential-roofing` and `/free-estimate`, which is
 * where most of a contractor's site actually lives.
 */
export type PageRole =
  | 'home'
  | 'about'
  | 'services'
  | 'contact'
  | 'quote'
  | 'pricing'
  | 'service_area'
  | 'other';

export type CrawlPage = {
  path: string;
  url: string;
  status: number;
  html: string;
  bytes: number;
  /** What this page appears to be, used to label content for the agent. */
  role: PageRole;
  /** How we came to fetch it — provenance for the admin panel. */
  discoveredVia: 'seed' | 'link' | 'guess';
};

export type CrawlResult = {
  ok: boolean;
  origin: string;
  pages: CrawlPage[];
  bytesFetched: number;
  latencyMs: number;
  /** Stable across runs when the site has not changed; skips re-enrichment. */
  contentHash: string | null;
  /** Every URL considered, with why it was or was not fetched. */
  attempts: CrawlAttempt[];
  errorCode?: string;
  errorMessage?: string;
};

export type CrawlAttempt = {
  url: string;
  path: string;
  outcome: 'fetched' | 'skipped' | 'failed';
  status?: number;
  reason?: string;
};

/**
 * How a path earns a place in the crawl.
 *
 * Ordered by what actually answers a qualification question: what they do, how
 * to reach them, whether there is a quote flow, and where they work.
 */
const ROLE_RULES: Array<{ role: PageRole; weight: number; patterns: RegExp[] }> = [
  { role: 'services', weight: 90, patterns: [/services?/, /what-we-do/, /solutions?/, /repairs?/, /installation/] },
  { role: 'contact', weight: 85, patterns: [/contact/, /get-in-touch/, /reach-us/] },
  { role: 'quote', weight: 80, patterns: [/quote/, /estimate/, /consultation/, /book/, /booking/, /appointment/, /schedule/] },
  { role: 'about', weight: 70, patterns: [/about/, /our-story/, /our-team/, /who-we-are/, /company/, /meet-the/] },
  { role: 'service_area', weight: 60, patterns: [/service-area/, /areas?-we-serve/, /locations?/, /coverage/, /where-we-work/] },
  { role: 'pricing', weight: 55, patterns: [/pricing/, /prices?/, /rates?/, /cost/, /financing/] },
];

/** Tried when the site's own links do not cover a role. */
const FALLBACK_PATHS = [
  '/about',
  '/about-us',
  '/services',
  '/contact',
  '/contact-us',
  '/request-a-quote',
  '/quote',
  '/service-areas',
];

/** Never worth a request: assets, feeds, legal boilerplate, endless archives. */
const EXCLUDED = [
  /\.(pdf|jpe?g|png|gif|svg|webp|ico|css|js|zip|mp4|mp3|xml|json|woff2?|ttf)$/i,
  /\/(wp-content|wp-admin|wp-json|cdn-cgi|feed|rss|amp)\b/i,
  /\/(privacy|terms|cookie|sitemap|disclaimer|accessibility)/i,
  /\/(blog|news|articles?|posts?|category|tag|author|archive)\//i,
  /\/(cart|checkout|account|login|signin|register)\b/i,
];

const MAX_BYTES_PER_PAGE = 1_500_000;
/** A ceiling on how many links we will even consider ranking. */
const MAX_LINKS_CONSIDERED = 400;

export type CrawlOptions = {
  maxPages?: number;
  timeoutMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
};

/** Minimal robots.txt handling: honour Disallow for our agent and for `*`. */
async function fetchDisallowedPaths(origin: string, userAgent: string, timeoutMs: number): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(`${origin}/robots.txt`, userAgent, timeoutMs);
    if (!response.ok) return [];
    const text = (await response.text()).slice(0, 100_000);

    const disallowed: string[] = [];
    let applies = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.split('#')[0]!.trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(':');
      const key = rawKey!.trim().toLowerCase();
      const value = rest.join(':').trim();

      if (key === 'user-agent') {
        applies = value === '*' || userAgent.toLowerCase().includes(value.toLowerCase());
      } else if (key === 'disallow' && applies && value) {
        disallowed.push(value);
      }
    }
    return disallowed;
  } catch {
    // A missing or unreachable robots.txt is not permission to ignore it, but
    // it is also not a reason to abandon the crawl.
    return [];
  }
}

function isDisallowed(path: string, disallowed: string[]): boolean {
  return disallowed.some((rule) => rule === '/' || path.startsWith(rule));
}

/** Classifies a path, and scores how much we want it. */
export function classifyPath(path: string): { role: PageRole; weight: number } {
  if (path === '/' || path === '') return { role: 'home', weight: 100 };
  const lower = path.toLowerCase();
  for (const rule of ROLE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(lower))) {
      // Shallower paths win: /services beats /services/roofing/shingles.
      const depth = lower.split('/').filter(Boolean).length;
      return { role: rule.role, weight: rule.weight - Math.min(20, (depth - 1) * 8) };
    }
  }
  return { role: 'other', weight: 0 };
}

/**
 * Same-origin links from the page's own markup.
 *
 * Deliberately regex-based over a DOM parser: the input is hostile third-party
 * markup, we want a handful of hrefs, and everything extracted is treated as an
 * untrusted string that is only ever used to build a URL against a fixed
 * origin — never executed, never interpolated into HTML.
 */
export function sameOriginLinks(html: string, origin: string): string[] {
  const paths = new Set<string>();

  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    if (paths.size >= MAX_LINKS_CONSIDERED) break;
    const raw = match[1]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    // A scheme we will not follow is dropped here rather than resolved.
    if (/^(javascript|data|mailto|tel|sms|ftp|file):/i.test(raw)) continue;

    let url: URL;
    try {
      url = new URL(raw, `${origin}/`);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (EXCLUDED.some((pattern) => pattern.test(path))) continue;
    paths.add(path);
  }

  return [...paths];
}

async function fetchWithTimeout(url: string, userAgent: string, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    return await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function crawlWebsite(website: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const started = Date.now();
  const e = env();
  const maxPages = options.maxPages ?? Number(e.CRAWL_MAX_PAGES);
  const timeoutMs = options.timeoutMs ?? Number(e.CRAWL_TIMEOUT_MS);
  const userAgent = options.userAgent ?? e.CRAWL_USER_AGENT;

  const normalized = normalizeWebsite(website);
  if (!normalized) {
    return {
      ok: false,
      origin: '',
      pages: [],
      bytesFetched: 0,
      latencyMs: 0,
      contentHash: null,
      attempts: [],
      errorCode: 'INVALID_URL',
      errorMessage: `"${website}" is not a usable website address`,
    };
  }

  const origin = new URL(normalized.url).origin;
  const disallowed = await fetchDisallowedPaths(origin, userAgent, timeoutMs);

  const pages: CrawlPage[] = [];
  const attempts: CrawlAttempt[] = [];
  const fetched = new Set<string>();
  let bytesFetched = 0;
  // Held in a box: a `let` written only inside the closure below narrows to
  // `never` at the read sites, which is a type error rather than a real one.
  const firstError: { value: { code: string; message: string } | null } = { value: null };

  /** Sequential by design: one business's site is never worth hitting in parallel. */
  const fetchPath = async (path: string, via: CrawlPage['discoveredVia'], role: PageRole) => {
    if (fetched.has(path)) return null;
    fetched.add(path);

    const url = `${origin}${path === '/' ? '' : path}`;
    if (isDisallowed(path, disallowed)) {
      attempts.push({ url, path, outcome: 'skipped', reason: 'disallowed by robots.txt' });
      return null;
    }

    try {
      const response = await fetchWithTimeout(url, userAgent, timeoutMs, options.signal);

      if (!response.ok) {
        attempts.push({ url, path, outcome: 'failed', status: response.status, reason: `HTTP ${response.status}` });
        if (path === '/' && !firstError.value) {
          firstError.value = { code: `HTTP_${response.status}`, message: `Homepage returned ${response.status}` };
        }
        return null;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('html')) {
        attempts.push({ url, path, outcome: 'skipped', reason: `content-type ${contentType || 'unknown'}` });
        return null;
      }

      const html = (await response.text()).slice(0, MAX_BYTES_PER_PAGE);
      bytesFetched += html.length;
      const page: CrawlPage = {
        path,
        url,
        status: response.status,
        html,
        bytes: html.length,
        role,
        discoveredVia: via,
      };
      pages.push(page);
      attempts.push({ url, path, outcome: 'fetched', status: response.status });
      return page;
    } catch (error) {
      const code = error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAILED';
      const message = error instanceof Error ? error.message.slice(0, 200) : 'fetch failed';
      attempts.push({ url, path, outcome: 'failed', reason: `${code}: ${message}` });
      if (path === '/' && !firstError.value) firstError.value = { code, message };
      return null;
    }
  };

  // 1. The homepage, which is also where the site tells us what else it has.
  const home = await fetchPath('/', 'seed', 'home');

  // 2. Rank the site's own links, then fill any unrepresented role from the
  //    fallback list — a site with no nav still gets /about and /contact tried.
  const linked = home ? sameOriginLinks(home.html, origin) : [];
  const ranked = linked
    .map((path) => ({ path, ...classifyPath(path), via: 'link' as const }))
    .filter((candidate) => candidate.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const covered = new Set(ranked.map((candidate) => candidate.role));
  const fallbacks = FALLBACK_PATHS.map((path) => ({ path, ...classifyPath(path), via: 'guess' as const }))
    .filter((candidate) => !covered.has(candidate.role))
    .sort((a, b) => b.weight - a.weight);

  // One page per role first, so six slots do not all go to service sub-pages.
  const queue = [...ranked, ...fallbacks];
  const usedRoles = new Set<PageRole>();
  const firstPass = queue.filter((candidate) => {
    if (usedRoles.has(candidate.role)) return false;
    usedRoles.add(candidate.role);
    return true;
  });
  const secondPass = queue.filter((candidate) => !firstPass.includes(candidate));

  for (const candidate of [...firstPass, ...secondPass]) {
    if (pages.length >= maxPages) break;
    if (options.signal?.aborted) break;
    await fetchPath(candidate.path, candidate.via, candidate.role);
  }

  const ok = pages.length > 0;
  if (!ok) {
    logger.debug('crawl produced no pages', { provider: 'crawler', errorCode: firstError.value?.code });
  }

  return {
    ok,
    origin,
    pages,
    bytesFetched,
    latencyMs: Date.now() - started,
    contentHash: ok ? hashPages(pages) : null,
    attempts,
    errorCode: ok ? undefined : (firstError.value?.code ?? 'NO_PAGES'),
    errorMessage: ok ? undefined : (firstError.value?.message ?? 'No pages could be fetched'),
  };
}

/** Hash of the fetched markup, so unchanged sites skip re-enrichment. */
function hashPages(pages: CrawlPage[]): string {
  const hash = createHash('sha256');
  for (const page of pages) hash.update(page.path).update(page.html);
  return hash.digest('hex').slice(0, 32);
}

/**
 * Builds a `CrawlPage` from markup, inferring role and path.
 *
 * Used by tests and by anything that has HTML in hand without having fetched
 * it, so a fixture cannot drift from the real shape.
 */
export function pageFromHtml(url: string, html: string, status = 200): CrawlPage {
  let path = '/';
  try {
    path = new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    path = '/';
  }
  return {
    path,
    url,
    status,
    html,
    bytes: html.length,
    role: classifyPath(path).role,
    discoveredVia: path === '/' ? 'seed' : 'link',
  };
}
