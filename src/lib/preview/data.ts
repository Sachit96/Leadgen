import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { organizations } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { logger } from '@/lib/core/logger';

/**
 * Migrates and seeds the in-memory preview database on first use.
 *
 * Neither can happen at boot. The module that opens the embedded database is
 * bundled into `instrumentation.ts`, where `serverExternalPackages` does not
 * apply — and the migrator reads the migrations folder (`node:fs`) while the
 * seed runs through the service layer (`pg`). Either import fails that build.
 * So the database is opened empty at boot and brought up here, on the first
 * request that needs it.
 *
 * Guarded three ways — the flag, an in-flight promise, and an emptiness check —
 * so it cannot run twice, cannot race itself, and can never touch a database
 * that already has an organization in it. Outside UI preview it returns
 * immediately and nothing below is reachable.
 */
let inFlight: Promise<void> | null = null;

export function isPreview(): boolean {
  return env().UI_PREVIEW === 'true';
}

export async function ensurePreviewData(): Promise<void> {
  if (!isPreview()) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // The real migrations, so the UI renders against the schema that ships.
    // Idempotent — the migrator tracks what it has applied.
    const { isInMemory } = await import('@/lib/db/embedded');
    if (isInMemory()) {
      const { migrate } = await import('drizzle-orm/pglite/migrator');
      const { drizzle } = await import('drizzle-orm/pglite');
      // The PGlite client the handle was built on, reused rather than reopened:
      // a second client would be a second, empty in-memory database.
      const client = (getDb() as unknown as { $client: unknown }).$client;
      await migrate(drizzle(client as never), { migrationsFolder: 'drizzle' });
    }

    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations);

    // Anything already here is someone's data, preview or not. Leave it alone.
    if ((rows[0]?.count ?? 0) > 0) return;

    // Said out loud: the first request pays for this, and a silent 10-second
    // page load looks like a hang.
    logger.info('seeding UI preview database — first request only', { provider: 'preview' });
    const { seedDemoData } = await import('@/lib/seed/demo');
    const { seedCallDemo } = await import('@/lib/seed/calls');
    const { systemCtx } = await import('@/lib/auth/context');

    const result = await seedDemoData();
    // The same lead pipeline the real seed runs, so the lead-generation and
    // calling screens render genuine rows rather than empty states — but sized
    // for a page request rather than a terminal. Two dozen leads is enough to
    // style a table, a queue and a funnel against; `npm run db:seed` produces
    // a hundred and thirty if you want volume.
    await seedCallDemo(systemCtx(result.organizationId), {
      searches: [
        { query: 'roofing', location: 'Mississauga, ON', count: 12 },
        { query: 'plumbing', location: 'Brampton, ON', count: 10 },
      ],
    });

    logger.info('UI preview database ready', { provider: 'preview' });
  })();

  try {
    await inFlight;
  } catch (error) {
    // Let the next request try again rather than caching the failure forever.
    inFlight = null;
    throw error;
  }
}
