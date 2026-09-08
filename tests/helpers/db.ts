import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@/lib/db/schema';
import { setDb, type Db } from '@/lib/db';

/**
 * Boots an in-memory Postgres (PGlite) with the real migrations applied and
 * installs it as the process-wide handle.
 *
 * Tests therefore exercise the same SQL, constraints and indexes as
 * production. The single cast here is the only place the app is allowed to not
 * know which driver it is talking to.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: 'drizzle' });
  setDb(db);
  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}
