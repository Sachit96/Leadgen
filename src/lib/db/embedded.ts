import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from './schema';

/**
 * The embedded Postgres engine.
 *
 * Deliberately isolated from `./index`, which imports `pg`: this module is
 * loaded by `instrumentation.ts`, and Next bundles that as its own entry where
 * `serverExternalPackages` does not apply — so pulling `pg` in from here breaks
 * the build with "Can't resolve 'fs'".
 *
 * That includes `import type`. A type-only import of `Db` from `./index` was
 * enough to drag the whole of `pg` into this bundle, because the bundler for
 * this entry resolves the module before types are stripped. So this file
 * declares no shared types and returns the handle untyped; `./index` casts it
 * at the one place that consumes it, where importing `pg` is fine.
 *
 * `pglite://<path>` writes to a local directory instead of a server, and
 * `pglite://memory` keeps it in RAM and throws it away on exit. Both are the
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

/** True when the database should live in RAM and vanish with the process. */
export function isInMemory(url = process.env.DATABASE_URL ?? ''): boolean {
  const path = embeddedPath(url);
  return path === 'memory' || path === ':memory:';
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
  // No argument means in-memory: nothing on disk, nothing to create, nothing
  // left behind. There is no directory to make, which is also why this module
  // can stay free of `node:fs`.
  return isInMemory(url) ? new PGlite() : new PGlite(embeddedPath(url));
}

export async function initEmbeddedDb(url = process.env.DATABASE_URL ?? ''): Promise<unknown> {
  const holder = globalThis as { __onRadarDb?: unknown };
  if (holder.__onRadarDb) return holder.__onRadarDb;

  const client = await createEmbeddedClient(url);
  const db = drizzlePglite(client, { schema });
  holder.__onRadarDb = db;

  // Opening is all this module can do. An in-memory database also needs
  // migrating and seeding, and both reach `node:fs` (the migrator reads the
  // migration folder) or `pg` (the service layer) — neither of which can be
  // pulled into the instrumentation bundle. `ensurePreviewData()` handles it on
  // the first request instead, where those imports are fine.
  return db;
}
