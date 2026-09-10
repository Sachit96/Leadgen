/**
 * A fake web, for exercising the real crawler.
 *
 * The crawler is the piece most likely to break silently — a path list that
 * stops matching, a link parser that drops relative hrefs, an extractor that
 * throws content away. Testing it against a stub of `fetch` runs the actual
 * crawler code (robots.txt, link discovery, role ranking, byte caps, content
 * types) over markup we control, with no network.
 */
export type FakeSite = {
  /** Path -> response. Paths are exact, including '/'. */
  pages: Record<string, { html?: string; status?: number; contentType?: string }>;
  robots?: string;
  /** Every path fails with a network error — a site that will not load. */
  unreachable?: boolean;
};

export type FakeWeb = {
  /** host -> site */
  sites: Record<string, FakeSite>;
  requests: string[];
  restore: () => void;
};

/** Installs a `fetch` that serves the given hosts and refuses everything else. */
export function installFakeWeb(sites: Record<string, FakeSite>): FakeWeb {
  const original = globalThis.fetch;
  const web: FakeWeb = { sites, requests: [], restore: () => { globalThis.fetch = original; } };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    web.requests.push(url.href);

    const site = web.sites[url.hostname];
    if (!site) throw new TypeError(`fetch failed: no fake host for ${url.hostname}`);
    if (site.unreachable) throw new TypeError('fetch failed: ECONNREFUSED');

    // Honour abort, so timeout handling is exercised rather than bypassed.
    if (init?.signal?.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }

    if (url.pathname === '/robots.txt') {
      return site.robots === undefined
        ? new Response('not found', { status: 404 })
        : new Response(site.robots, { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const page = site.pages[path];
    if (!page) return new Response('not found', { status: 404 });

    return new Response(page.html ?? '', {
      status: page.status ?? 200,
      headers: { 'content-type': page.contentType ?? 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  return web;
}

/**
 * A believable contractor site: nav-linked pages under names a fixed path list
 * would miss, an ads tag, no booking flow, no CRM — the shape of an ICP match.
 */
export function contractorSite(name = 'Summit Roofing'): FakeSite {
  const nav = `
    <nav>
      <a href="/">Home</a>
      <a href="/our-services">Services</a>
      <a href="/meet-the-team">About</a>
      <a href="/get-in-touch">Contact</a>
      <a href="/free-estimate">Free Estimate</a>
      <a href="/areas-we-serve">Service Areas</a>
      <a href="/blog/why-shingles-fail">Blog</a>
      <a href="/privacy-policy">Privacy</a>
      <a href="https://facebook.com/summitroofing">Facebook</a>
      <a href="mailto:hello@summit.example">Email</a>
    </nav>`;

  const page = (title: string, body: string) => ({
    html: `<html><head><title>${title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="description" content="${name} installs and repairs roofs across the west GTA.">
      <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11223344"></script>
      </head><body>${nav}${body}</body></html>`,
  });

  return {
    robots: 'User-agent: *\nDisallow: /wp-admin\n',
    pages: {
      '/': page(
        `${name} | Roofing Contractor`,
        `<h1>${name}</h1>
         <p>We have installed roofs across Mississauga since 1998, and we answer the phone.</p>
         <p>24/7 emergency roof repair available.</p>`,
      ),
      '/our-services': page(
        'Our Services',
        `<h2>Roofing Services</h2>
         <p>We handle roof replacement, roof repair, flat roof systems, siding and eavestrough work.</p>`,
      ),
      '/meet-the-team': page(
        'Meet the Team',
        '<h2>Our Team</h2><p>A family business run out of Mississauga for over 25 years.</p>',
      ),
      '/get-in-touch': page(
        'Contact Us',
        `<h2>Contact</h2>
         <p>Call <a href="tel:+19055550143">905-555-0143</a> or email hello@summit.example.</p>
         <form><input type="text" name="name"><input type="email" name="email"><button>Send</button></form>`,
      ),
      '/free-estimate': page(
        'Free Estimate',
        '<h2>Request a free estimate</h2><p>Get a quote for your roof in under a day.</p>',
      ),
      '/areas-we-serve': page(
        'Areas We Serve',
        '<h2>Service Areas</h2><p>Proudly serving Mississauga, Oakville, Burlington, Milton, Brampton and Etobicoke.</p>',
      ),
      '/blog/why-shingles-fail': page('Blog', '<p>Shingles fail for many reasons.</p>'),
      '/privacy-policy': page('Privacy', '<p>Privacy policy.</p>'),
    },
  };
}
