/**
 * Drops every application table and re-applies migrations. Destructive by
 * design and refuses to run against NODE_ENV=production.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from '../src/lib/db';

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--i-know-what-i-am-doing')) {
    throw new Error('Refusing to reset a production database');
  }

  const db = getDb();
  console.log('Dropping schema…');
  await db.execute(sql`drop schema public cascade; create schema public;`);

  console.log('Re-applying migrations…');
  await migrate(db, { migrationsFolder: 'drizzle' });

  console.log('Database reset. Run `npm run db:seed` to load demo data.');
  await getPool().end();
}

main().catch((error) => {
  console.error('Reset failed:', error);
  process.exit(1);
});
