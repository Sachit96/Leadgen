/**
 * One-command local setup.
 *
 * Writes a working .env if there is not one already, applies migrations, and
 * seeds demo data. Defaults to the embedded database so there is nothing to
 * install — if you already have Postgres, set DATABASE_URL first and this uses
 * it instead.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ENV_PATH = '.env';

function ensureEnv(): void {
  if (existsSync(ENV_PATH)) {
    const current = readFileSync(ENV_PATH, 'utf8');
    const missing = ['DATABASE_URL', 'SESSION_SECRET'].filter(
      (key) => !new RegExp(`^${key}=.+`, 'm').test(current),
    );
    if (missing.length === 0) {
      console.log('  .env already configured — leaving it alone.');
      return;
    }
    console.log(`  .env is missing ${missing.join(' and ')}; add them and re-run.`);
    process.exit(1);
  }

  // Generated rather than asking for openssl, which not every machine has.
  const secret = randomBytes(48).toString('base64');
  writeFileSync(
    ENV_PATH,
    `# Written by \`npm run setup\`. Safe to edit; never commit this file.

# The embedded Postgres engine — no server to install. Point this at a real
# Postgres connection string for production.
DATABASE_URL=pglite://./data/onradar
DATABASE_SSL=false

SESSION_SECRET=${secret}
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Runs the worker inside the app, so \`npm run dev\` is a complete system.
DEMO_MODE=true

# No credentials needed: every integration falls back to a working in-process
# mock. Settings -> Integrations always shows which mode each one is in.
SMS_PROVIDER=mock
AI_PROVIDER=mock
CALENDAR_PROVIDER=internal

LOG_LEVEL=info
WORKER_INTERVAL_MS=5000
`,
    'utf8',
  );
  console.log('  Wrote .env with a generated session secret.');
}

function run(label: string, script: string): void {
  console.log(`\n${label}`);
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\nSetting up On Radar…\n');
ensureEnv();
run('Applying the database schema…', 'db:migrate');
run('Loading demo data…', 'db:seed');

console.log(`
  Ready. Start it with:

      npm run dev

  Then open http://localhost:3000 and sign in with the credentials above.
`);
