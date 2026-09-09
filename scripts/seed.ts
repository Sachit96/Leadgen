/**
 * Seeds an organization with the default campaign, prompts, knowledge base and
 * a realistic demo dataset. Safe to run against an empty database.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getPool, initDb, isEmbedded } from '../src/lib/db';
import { organizations } from '../src/lib/db/schema';
import { seedDemoData } from '../src/lib/seed/demo';
import { seedCallDemo } from '../src/lib/seed/calls';
import { systemCtx } from '../src/lib/auth/context';

async function main() {
  const db = await initDb();

  const existing = await db.select({ count: sql<number>`count(*)::int` }).from(organizations);
  if ((existing[0]?.count ?? 0) > 0 && !process.argv.includes('--force')) {
    console.log('Database already contains an organization. Re-run with --force to seed another.');
    await close();
    return;
  }

  const result = await seedDemoData({
    email: process.env.SEED_EMAIL ?? 'owner@onradar.local',
    password: process.env.SEED_PASSWORD ?? 'onradar-demo-2026',
  });

  // The calling demo runs the real lead pipeline, which takes a moment.
  const calls = process.argv.includes('--no-calls')
    ? null
    : await seedCallDemo(systemCtx(result.organizationId));

  console.log('');
  console.log('  On Radar demo data seeded.');
  console.log('  ------------------------------------------');
  console.log(`  Sign in at   http://localhost:3000/login`);
  console.log(`  Email        ${result.email}`);
  console.log(`  Password     ${result.password}`);
  console.log(`  Prospects    ${result.prospects}`);
  if (calls) {
    console.log(`  Leads        ${calls.leads} from ${calls.searches} searches`);
    console.log(`  Call ready   ${calls.callReady}`);
    console.log(`  Call queue   ${calls.queueSize} in "Today's calls"`);
  }
  console.log('');

  await close();
}

/** The embedded engine has no pool to drain; the process just exits. */
async function close(): Promise<void> {
  if (!isEmbedded()) await getPool().end();
}

main().catch(async (error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
