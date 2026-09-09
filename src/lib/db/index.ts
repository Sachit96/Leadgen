import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { env } from '@/lib/env';


/**
 * The single database handle type used everywhere in the app.
 *
 * Tests run against PGlite; the harness casts its driver to this type so that
 * application and service code never has to know which driver is underneath.
 */
export type Db = NodePgDatabase<typeof schema>;

declare global {
  var __onRadarPool: Pool | undefined;
  var __onRadarDb: Db | undefined;
}

/**
 * Overrides the process-wide handle. Used by the test harness and by the
 * seeding scripts so they can share one connection.
 */
export function setDb(db: Db): void {
  globalThis.__onRadarDb = db;
}

export function getPool(): Pool {
  if (globalThis.__onRadarPool) return globalThis.__onRadarPool;
  const e = env();
  const pool = new Pool({
    connectionString: e.DATABASE_URL,
    ssl: e.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  globalThis.__onRadarPool = pool;
  return pool;
}

/** Lazily creates (and caches) the process-wide Drizzle handle. */
export function getDb(): Db {
  if (globalThis.__onRadarDb) return globalThis.__onRadarDb;
  if (env().DATABASE_URL.startsWith('pglite://')) {
    throw new Error(
      'The embedded database must be opened before use. Call initDb() first.',
    );
  }
  const db = drizzle(getPool(), { schema });
  globalThis.__onRadarDb = db;
  return db;
}


/** Opens whichever database DATABASE_URL points at. */
export async function initDb(): Promise<Db> {
  const { isEmbedded, initEmbeddedDb } = await import('./embedded');
  if (isEmbedded(env().DATABASE_URL)) return initEmbeddedDb();
  return getDb();
}

export { createEmbeddedClient, embeddedPath, isEmbedded } from './embedded';

export { schema };
