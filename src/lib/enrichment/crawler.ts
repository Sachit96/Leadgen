import { createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/core/logger';
import { normalizeWebsite } from '@/lib/lead-generation/normalize';

/**
 * A deliberately small website crawler.
 *
 * This is not a spider. It fetches a fixed list of paths that businesses
 * actually put their contact and service information on, obeys robots.txt,
 * caps bytes and time, and never follows links off the origin. The goal is to
 * learn enough about one business to write an honest opening line — not to
 * index the web.
 */
export type CrawlPage = {
  path: string;
  url: string;
  status: number;
  html: string;
  bytes: number;
};

export type CrawlResult = {
  ok: boolean;
  origin: string;
  pages: CrawlPage[];
  bytesFetched: number;
  latencyMs: number;
  /** Stable across runs when the site has not changed; skips re-enrichment. */
  contentHash: string | null;
  errorCode?: string;
  errorMessage?: string;
};

/** The pages worth fetching, in priority order. */
const CANDIDATE_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/services',
  '/contact',
  '/contact-us',
  '/book',
  '/booking',
  '/appointment',
  '/request-a-quote',
  '/quote',
];

const MAX_BYTES_PER_PAGE = 1_500_000;

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
      errorCode: 'INVALID_URL',
      errorMessage: `"${website}" is not a usable website address`,
    };
  }

  const origin = new URL(normalized.url).origin;
  const disallowed = await fetchDisallowedPaths(origin, userAgent, timeoutMs);

  const pages: CrawlPage[] = [];
  let bytesFetched = 0;
  let firstError: { code: string; message: string } | null = null;

  // Sequential, one page at a time: a single business's site is never worth
  // hitting concurrently, and this guarantees per-domain politeness.
  for (const path of CANDIDATE_PATHS) {
    if (pages.length >= maxPages) break;
    if (options.signal?.aborted) break;
    if (isDisallowed(path, disallowed)) continue;

    const url = `${origin}${path}`;
    try {
      const response = await fetchWithTimeout(url, userAgent, timeoutMs, options.signal);

      // A 404 on /about is expected, not an error worth reporting.
      if (!response.ok) {
        if (path === '/' && !firstError) {
          firstError = { code: `HTTP_${response.status}`, message: `Homepage returned ${response.status}` };
        }
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('html')) continue;

      const html = (await response.text()).slice(0, MAX_BYTES_PER_PAGE);
      bytesFetched += html.length;
      pages.push({ path, url, status: response.status, html, bytes: html.length });
    } catch (error) {
      if (path === '/' && !firstError) {
        firstError = {
          code: error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAILED',
          message: error instanceof Error ? error.message.slice(0, 200) : 'fetch failed',
        };
      }
    }
  }

  const ok = pages.length > 0;
  if (!ok) {
    logger.debug('crawl produced no pages', { provider: 'crawler', errorCode: firstError?.code });
  }

  return {
    ok,
    origin,
    pages,
    bytesFetched,
    latencyMs: Date.now() - started,
    contentHash: ok ? hashPages(pages) : null,
    errorCode: ok ? undefined : (firstError?.code ?? 'NO_PAGES'),
    errorMessage: ok ? undefined : (firstError?.message ?? 'No pages could be fetched'),
  };
}

/** Hash of the fetched markup, so unchanged sites skip re-enrichment. */
function hashPages(pages: CrawlPage[]): string {
  const hash = createHash('sha256');
  for (const page of pages) hash.update(page.path).update(page.html);
  return hash.digest('hex').slice(0, 32);
}
