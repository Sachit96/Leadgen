/**
 * Applies pending Drizzle migrations to DATABASE_URL.
 * Safe to run repeatedly; the migrator tracks applied files itself.
 */
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createEmbeddedClient, embeddedPath, isEmbedded } from '../src/lib/db';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');

  console.log('Applying migrations…');

  if (isEmbedded(url)) {
    const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');
    const { migrate: migratePglite } = await import('drizzle-orm/pglite/migrator');

    // PGlite's own mkdir is not recursive, so a fresh checkout needs this.
    mkdirSync(embeddedPath(url), { recursive: true });
    const client = await createEmbeddedClient(url);
    await migratePglite(drizzlePglite(client), { migrationsFolder: 'drizzle' });
    await client.close();
    console.log(`Migrations up to date (embedded database at ${embeddedPath(url)}).`);
    return;
  }

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
  console.log('Migrations up to date.');
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
