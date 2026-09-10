import { createHash } from 'node:crypto';

/**
 * Websites for the synthetic businesses.
 *
 * The mock discovery provider invents businesses on `.example` domains, which
 * by RFC 2606 can never resolve. Without this, a demo or a test discovers 150
 * businesses and crawls none of them — the crawler, the extractor, the signal
 * detector and the research agent all sit idle behind a wall of failed fetches,
 * and the demo becomes exactly the hollow shell it is meant to disprove.
 *
 * So the synthetic world gets synthetic websites: deterministic, varied enough
 * that signal detection has something to find and miss, and served in-process.
 *
 * The safety property is structural, not a matter of care: this only ever
 * answers for hosts under `.example`, a TLD reserved for documentation that
 * cannot exist on the public internet. It is wired in only when the *discovery*
 * provider is the mock one, so a real provider is never served fake pages.
 */
const RESERVED_TLD = '.example';

/**
 * What the synthetic provider said about each business it invented.
 *
 * The fake world has to agree with itself: if discovery lists a number for a
 * business, that business's website should publish the same number, or the
 * corroboration logic has nothing real to corroborate and every synthetic lead
 * looks like it has a mismatched tracking number.
 *
 * In-process and bounded — discovery and crawling happen in the same worker.
 * A host that is not registered still gets a site, just with a derived number.
 */
const registry = new Map<string, { phone: string | null; businessName: string }>();

export function registerSyntheticBusiness(
  website: string,
  facts: { phone: string | null; businessName: string },
): void {
  try {
    const host = new URL(website).hostname.toLowerCase();
    if (!host.endsWith(RESERVED_TLD)) return;
    if (registry.size > 5_000) registry.clear();
    registry.set(host, facts);
  } catch {
    // A website we cannot parse is one we will not be asked to serve.
  }
}

export function clearSyntheticRegistry(): void {
  registry.clear();
}

/** Deterministic per-host, so the same business always has the same site. */
function seededRandom(seed: string): () => number {
  let state = parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

type SiteProfile = {
  hasViewport: boolean;
  hasForm: boolean;
  hasEmailField: boolean;
  hasPhone: boolean;
  hasEmail: boolean;
  hasCta: boolean;
  hasAds: boolean;
  hasAnalytics: boolean;
  hasChat: boolean;
  hasBooking: boolean;
  hasCrm: boolean;
  hasEmergency: boolean;
  areaCount: number;
  dead: boolean;
};

function profileFor(host: string): SiteProfile {
  const random = seededRandom(host);
  return {
    // A realistic spread: most sites are competent, a meaningful minority are
    // exactly the neglected ones the product exists to find.
    hasViewport: random() > 0.25,
    hasForm: random() > 0.3,
    hasEmailField: random() > 0.4,
    hasPhone: random() > 0.15,
    hasEmail: random() > 0.3,
    hasCta: random() > 0.35,
    hasAds: random() > 0.55,
    hasAnalytics: random() > 0.3,
    hasChat: random() > 0.8,
    hasBooking: random() > 0.85,
    hasCrm: random() > 0.85,
    hasEmergency: random() > 0.6,
    areaCount: Math.floor(random() * 8),
    // Some businesses genuinely have no working site. That is a finding.
    dead: random() > 0.88,
  };
}

const AREAS = [
  'Mississauga', 'Oakville', 'Burlington', 'Milton', 'Brampton',
  'Etobicoke', 'Toronto', 'Vaughan', 'Markham', 'Ajax',
];

const TRADE_SERVICES: Record<string, string[]> = {
  roof: ['roof replacement', 'roof repair', 'flat roof', 'eavestrough', 'siding'],
  plumb: ['plumbing repair', 'drain', 'water heater', 'emergency service'],
  hvac: ['furnace', 'air conditioning', 'heat pump', 'ductwork'],
  landscap: ['landscaping', 'hardscape', 'lawn care', 'snow removal', 'interlock'],
};

function servicesFor(host: string): string[] {
  for (const [needle, services] of Object.entries(TRADE_SERVICES)) {
    if (host.includes(needle)) return services;
  }
  return ['roof repair', 'siding'];
}

function titleize(host: string): string {
  return host
    .replace(RESERVED_TLD, '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function renderPage(host: string, path: string, profile: SiteProfile): string | null {
  const known = registry.get(host);
  const name = known?.businessName ?? titleize(host);
  // The number the provider listed, so corroboration has something real to
  // check. Falls back to a derived one for a host we never registered.
  const phone = known?.phone ?? '+19055550100';
  const email = `info@${host}`;
  const services = servicesFor(host);
  const areas = AREAS.slice(0, profile.areaCount);

  const head = [
    `<title>${name}${path === '/' ? '' : ` | ${path.replace(/[/-]/g, ' ').trim()}`}</title>`,
    profile.hasViewport ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : '',
    `<meta name="description" content="${name} provides ${services.slice(0, 2).join(' and ')} services.">`,
    profile.hasAds
      ? '<script async src="https://www.googletagmanager.com/gtag/js?id=AW-99887766"></script>'
      : '',
    profile.hasAnalytics
      ? '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDEF1234"></script>'
      : '',
    profile.hasChat ? '<script src="https://embed.tawk.to/widget.js"></script>' : '',
    profile.hasCrm ? '<script src="https://js.hs-scripts.com/1234567.js"></script>' : '',
  ].join('\n');

  const nav = `<nav>
    <a href="/">Home</a>
    <a href="/our-services">Services</a>
    <a href="/about-the-company">About</a>
    <a href="/get-in-touch">Contact</a>
    ${profile.hasCta ? '<a href="/request-an-estimate">Free Estimate</a>' : ''}
    ${areas.length > 0 ? '<a href="/areas-we-serve">Service Areas</a>' : ''}
    ${profile.hasBooking ? '<a href="https://calendly.com/demo/visit">Book online</a>' : ''}
    <a href="/privacy-policy">Privacy</a>
  </nav>`;

  const contactBlock = [
    profile.hasPhone ? `<p>Call <a href="tel:${phone}">${phone}</a></p>` : '',
    profile.hasEmail ? `<p>Email <a href="mailto:${email}">${email}</a></p>` : '',
    profile.hasForm
      ? `<form><input type="text" name="name">${profile.hasEmailField ? '<input type="email" name="email">' : ''}<button>Send</button></form>`
      : '',
  ].join('');

  const bodies: Record<string, string> = {
    '/': `<h1>${name}</h1>
      <p>${name} has served the area for over 20 years, handling ${services.join(', ')}.</p>
      ${profile.hasEmergency ? '<p>24/7 emergency service available.</p>' : ''}
      ${profile.hasCta ? '<p><a href="/request-an-estimate">Get a free quote today</a></p>' : ''}
      ${contactBlock}`,
    '/our-services': `<h2>Our Services</h2><ul>${services.map((s) => `<li>${s}</li>`).join('')}</ul>
      <p>We handle ${services.join(', ')} for residential and commercial customers.</p>`,
    '/about-the-company': `<h2>About ${name}</h2>
      <p>A family-run business operating since 2003, with a team of twelve.</p>`,
    '/get-in-touch': `<h2>Contact ${name}</h2>${contactBlock || '<p>Use the form on our Facebook page.</p>'}`,
    '/privacy-policy': '<h2>Privacy policy</h2><p>We respect your privacy.</p>',
  };

  if (profile.hasCta) {
    bodies['/request-an-estimate'] = `<h2>Request an estimate</h2>
      <p>Tell us about your project and we will get back to you.</p>${contactBlock}`;
  }
  if (areas.length > 0) {
    bodies['/areas-we-serve'] = `<h2>Areas We Serve</h2>
      <p>Proudly serving ${areas.slice(0, -1).join(', ')}${areas.length > 1 ? ` and ${areas.at(-1)}` : ''}.</p>`;
  }

  const body = bodies[path];
  if (body === undefined) return null;
  return `<!doctype html><html><head>${head}</head><body>${nav}${body}</body></html>`;
}

/**
 * A `fetch` that answers only for `.example` hosts.
 *
 * Anything else throws, so this can never stand in front of a real request.
 */
export const syntheticFetch: typeof fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);

  if (!url.hostname.endsWith(RESERVED_TLD)) {
    throw new TypeError(
      `syntheticFetch refuses ${url.hostname}: it only serves the reserved .example TLD`,
    );
  }
  if (init?.signal?.aborted) {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }

  const profile = profileFor(url.hostname);
  if (profile.dead) throw new TypeError('fetch failed: ECONNREFUSED');

  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /wp-admin\n', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  const html = renderPage(url.hostname, path, profile);
  if (html === null) return new Response('Not found', { status: 404 });

  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};
