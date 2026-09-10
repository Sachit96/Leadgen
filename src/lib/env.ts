import { z } from 'zod';

/**
 * Environment contract. Parsed once, lazily, on first server-side access so
 * that importing a module never crashes a build.
 *
 * Only DATABASE_URL and SESSION_SECRET are hard requirements. Everything else
 * degrades to a documented mock/disabled mode, which is what makes local demo
 * mode and the test suite runnable without credentials.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * A Postgres connection string, or `pglite://<path>` to use the embedded
   * engine (no server to install — see docs/DEPLOYMENT.md).
   */
  DATABASE_URL: z
    .string()
    .optional()
    .default('postgresql://postgres:postgres@localhost:5432/dummy'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),

  SESSION_SECRET: z
    .string()
    .optional()
    .default('dummy-secret-key-that-is-at-least-32-characters-long'),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  // --- SMS -----------------------------------------------------------------
  SMS_PROVIDER: z.enum(['twilio', 'telnyx', 'mock']).default('mock'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_PHONE_NUMBER: z.string().optional(),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  TELNYX_PUBLIC_KEY: z.string().optional(),

  // --- AI ------------------------------------------------------------------
  AI_PROVIDER: z.enum(['anthropic', 'mock']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  AI_MODEL_SMART: z.string().default('claude-sonnet-5'),

  // --- Lead discovery ------------------------------------------------------
  LEAD_DISCOVERY_PROVIDER: z.enum(['google_places', 'mock']).default('mock'),
  /** Google Places API (New). Billed per request — see LEAD_DISCOVERY_MAX_REQUESTS. */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /** Hard ceiling on provider requests per search job. */
  LEAD_DISCOVERY_MAX_REQUESTS: z.string().default('10'),
  /** Politeness controls for the website crawler. */
  CRAWL_CONCURRENCY: z.string().default('4'),
  CRAWL_TIMEOUT_MS: z.string().default('10000'),
  CRAWL_MAX_PAGES: z.string().default('6'),
  CRAWL_USER_AGENT: z.string().default('OnRadarBot/1.0 (+https://onradar.example/bot)'),

  /**
   * Calling.
   *
   * Only device telephony ships. The variable exists so adding a voice provider
   * is a configuration change rather than a code change — and so the one thing
   * that follows from `device` (the app cannot observe a connection) is stated
   * where someone configuring the app will read it.
   */
  CALL_PROVIDER: z.enum(['device']).default('device'),

  // --- Calendar ------------------------------------------------------------
  CALENDAR_PROVIDER: z.enum(['google', 'internal']).default('internal'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),

  /**
   * UI preview mode.
   *
   * Boots an in-memory database, migrated and seeded on start, so the app runs
   * with no PostgreSQL to install and no data directory to manage. Everything
   * else stays real: real schema, real queries, real types, real login. The
   * point is to remove the *setup*, not the database — stubbing services out
   * returns plausible-looking zeros and hides the bugs you are trying to see.
   *
   * Nothing persists: restart the server and you get the seed back.
   */
  UI_PREVIEW: z.enum(['true', 'false']).default('false'),

  // --- Ops -----------------------------------------------------------------
  WORKER_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(previewDefaults(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values, or run ' +
        '`npm run setup` for a working local database. For a throwaway UI-only ' +
        'run with nothing to install, set UI_PREVIEW=true.',
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test/bootstrap helper — resets the memoized parse. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Reports which optional integrations are actually configured. The settings UI
 * renders this so an operator can see at a glance what is live and what is
 * running in mock mode.
 */
/**
 * The two values preview mode fills in for you.
 *
 * Applied before validation rather than by relaxing the schema, so DATABASE_URL
 * and SESSION_SECRET stay hard requirements everywhere else. A default signing
 * secret is only ever safe because it cannot be reached without UI_PREVIEW.
 */
function previewDefaults(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.UI_PREVIEW !== 'true') return source;

  // Written back onto process.env, not just into the parsed object: the module
  // that opens the embedded database reads process.env.DATABASE_URL directly
  // (it cannot import this one — see the note in db/embedded.ts). Leaving the
  // two disagreeing meant instrumentation saw no database and the app then
  // tried to open a Postgres pool on "pglite://memory".
  source.DATABASE_URL ??= 'pglite://memory';
  source.SESSION_SECRET ??= 'ui-preview-only-secret-not-for-any-deployed-environment';
  return source;
}

export function integrationStatus(e: Env = env()) {
  const twilioReady = Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_PHONE_NUMBER);
  const telnyxReady = Boolean(e.TELNYX_API_KEY && e.TELNYX_PHONE_NUMBER);
  const anthropicReady = Boolean(e.ANTHROPIC_API_KEY);
  const googleReady = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REFRESH_TOKEN);
  const placesReady = Boolean(e.GOOGLE_PLACES_API_KEY);
  return {
    sms: {
      selected: e.SMS_PROVIDER,
      effective: e.SMS_PROVIDER === 'twilio' && twilioReady
        ? 'twilio'
        : e.SMS_PROVIDER === 'telnyx' && telnyxReady
          ? 'telnyx'
          : 'mock',
      twilioReady,
      telnyxReady,
    },
    ai: {
      selected: e.AI_PROVIDER,
      effective: e.AI_PROVIDER === 'anthropic' && anthropicReady ? 'anthropic' : 'mock',
      anthropicReady,
    },
    discovery: {
      selected: e.LEAD_DISCOVERY_PROVIDER,
      effective: e.LEAD_DISCOVERY_PROVIDER === 'google_places' && placesReady ? 'google_places' : 'mock',
      placesReady,
    },
    /**
     * Calling. `configured` is true because device telephony needs no
     * credentials — but `reportsConnection` is what actually matters, and it is
     * false, which is why nothing in the app publishes a connect rate.
     */
    calling: {
      selected: e.CALL_PROVIDER,
      effective: e.CALL_PROVIDER,
      reportsConnection: false,
    },
    calendar: {
      selected: e.CALENDAR_PROVIDER,
      effective: e.CALENDAR_PROVIDER === 'google' && googleReady ? 'google' : 'internal',
      googleReady,
    },
  } as const;
}
