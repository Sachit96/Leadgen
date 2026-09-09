import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from './schema';
import type { Db } from './index';

/**
 * The embedded Postgres engine.
 *
 * Deliberately isolated from `./index`, which imports `pg`: this module is
 * loaded by `instrumentation.ts`, and Next bundles that as its own entry where
 * `serverExternalPackages` does not apply — so pulling `pg` in from here breaks
 * the build with "Can't resolve 'fs'".
 *
 * `pglite://<path>` writes to a local directory instead of a server. It is the
 * same engine the test suite runs the real migrations against, so the SQL,
 * constraints and indexes match a served Postgres exactly. Single-process,
 * which is why demo mode ticks the worker inside the app.
 */
export function isEmbedded(url = process.env.DATABASE_URL ?? ''): boolean {
  return url.startsWith('pglite://');
}

export function embeddedPath(url = process.env.DATABASE_URL ?? ''): string {
  return url.replace(/^pglite:\/\//, '') || './data/onradar';
}

/**
 * Opens the data directory.
 *
 * Creating it is the migration script's job, not this module's: `instrumentation.ts`
 * imports this file into its own webpack bundle, where a `node:fs` import is an
 * unhandled scheme and breaks the build. `npm run setup` always migrates before
 * the app starts, so the directory exists by then.
 */
export async function createEmbeddedClient(url = process.env.DATABASE_URL ?? '') {
  const { PGlite } = await import('@electric-sql/pglite');
  return new PGlite(embeddedPath(url));
}

export async function initEmbeddedDb(url = process.env.DATABASE_URL ?? ''): Promise<Db> {
  const existing = globalThis.__onRadarDb;
  if (existing) return existing;

  const client = await createEmbeddedClient(url);
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  globalThis.__onRadarDb = db;
  return db;
}
