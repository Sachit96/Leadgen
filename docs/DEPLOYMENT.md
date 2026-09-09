# Deployment

On Radar is one Next.js app plus one background worker, sharing a Postgres
database. Both run the same code; the worker is `scripts/worker.ts` calling the
same `tick()` the app exposes at `POST /api/worker/tick`.

The only hard requirement is that **something drives the worker**. Without it,
messages queue and nothing sends.

---

## 0. Local, with nothing installed

For a local demo, skip this whole page:

```bash
npm install && npm run setup && npm run dev
```

`setup` points `DATABASE_URL` at `pglite://./data/onradar`, an embedded Postgres
engine that needs no server, and turns on `DEMO_MODE` so the worker runs inside
the app. That mode is **not** for production: the embedded engine is
single-process, so it cannot be shared with a separate worker or a second app
instance. Everything below is the real deployment.

## 1. Database

Any Postgres 14+. Supabase, Neon, RDS, or self-hosted.

```bash
export DATABASE_URL='postgres://…'
export DATABASE_SSL=true          # for hosted Postgres
npm run db:migrate
```

Optional, and only if you also expose the database directly (Supabase client
libraries, a BI tool):

```bash
psql "$DATABASE_URL" -f drizzle/rls.sql
```

RLS is defence in depth. The service layer is the enforcement point, because the
app normally connects as a privileged role that bypasses RLS entirely. See the
header of that file.

## 2. Environment

Copy `.env.example` and fill it in. `DATABASE_URL` and `SESSION_SECRET` are
required; everything else degrades to a documented mock.

```bash
openssl rand -base64 48    # SESSION_SECRET
```

`NEXT_PUBLIC_APP_URL` must be the exact public origin your SMS provider posts
to — Twilio signs the full callback URL, so a mismatch fails verification and
every webhook is rejected with 403.

## 3. First run

Visit the deployed URL. With no organization yet, the login page becomes a
one-time setup form that creates the organization, the owner account, the
default prompts, the knowledge base, the objection library and the seeded
roofing campaign.

To load demo data instead:

```bash
npm run db:seed
```

---

## Option A — Vercel

The app deploys as-is. Vercel does not run long-lived processes, so drive the
worker from Cron.

1. Import the repository. Build command `npm run build`, no overrides needed.
2. Add every variable from `.env.example` in project settings.
3. Set `WORKER_TOKEN` to a long random string.
4. Add `vercel.json`:

```json
{
  "crons": [{ "path": "/api/worker/tick?token=YOUR_WORKER_TOKEN", "schedule": "* * * * *" }]
}
```

Vercel Cron's finest granularity is one minute, which sets the floor on
sequence and AI-reply latency. Manual sends from the inbox do not wait for it —
they run a bounded tick inline so the operator sees the message go out.

For sub-minute responsiveness, run the worker separately (Option B or C) and
point it at the same database.

## Option B — Single VPS

```bash
npm ci
npm run build
npm run db:migrate

# Process manager of choice; systemd units shown below.
npm start          # the app,    port 3000
npm run worker     # the worker
```

`/etc/systemd/system/onradar.service`:

```ini
[Unit]
Description=On Radar
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/onradar
EnvironmentFile=/srv/onradar/.env
ExecStart=/usr/bin/npm start
Restart=always
User=onradar

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/onradar-worker.service`:

```ini
[Unit]
Description=On Radar worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/onradar
EnvironmentFile=/srv/onradar/.env
ExecStart=/usr/bin/npm run worker
Restart=always
User=onradar

[Install]
WantedBy=multi-user.target
```

The worker drains in-flight work on SIGTERM before exiting, so `systemctl
restart` will not abandon a send mid-flight.

Run more than one worker if you need throughput — jobs are claimed with
`FOR UPDATE SKIP LOCKED`, so workers never collide.

## Option C — Docker

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
```

```yaml
services:
  app:
    build: .
    env_file: .env
    ports: ['3000:3000']
    depends_on: [db]

  worker:
    build: .
    env_file: .env
    command: npm run worker
    depends_on: [db]

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: onradar
    volumes: ['pgdata:/var/lib/postgresql/data']

volumes:
  pgdata:
```

---

## Connecting Twilio

1. Buy a number, or use a Messaging Service.
2. Set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_PHONE_NUMBER`.
3. On the number's configuration:
   - **A message comes in** → `POST https://your-domain/api/webhooks/sms/inbound`
   - **Status callback URL** → `POST https://your-domain/api/webhooks/sms/status`
4. Add the number in Settings → Integrations so inbound messages route to the
   right organization. (With a single organization this is unambiguous anyway.)

Both endpoints verify Twilio's `X-Twilio-Signature` and reject anything that
does not validate. Both are idempotent: a replayed event is recorded and
discarded rather than duplicated, so Twilio's retries are harmless.

**Verify it end to end** by texting the number and watching the conversation
appear in the inbox.

## Connecting Telnyx

Set `SMS_PROVIDER=telnyx`, `TELNYX_API_KEY`, `TELNYX_PHONE_NUMBER`,
`TELNYX_MESSAGING_PROFILE_ID`, and `TELNYX_PUBLIC_KEY` from the portal. Point
the messaging profile's webhook at the same two URLs. Without the public key,
webhooks are rejected — Telnyx signatures are Ed25519 and cannot be verified
without it.

## Connecting Google Calendar

Set `CALENDAR_PROVIDER=google` plus `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN` and `GOOGLE_CALENDAR_ID`. Obtain the refresh token once
with the `https://www.googleapis.com/auth/calendar` scope; the worker needs to
write events with no user present, which is why it is a stored refresh token
rather than a per-request OAuth flow.

Appointments are always stored in On Radar. Google mirrors them outward and
feeds real free/busy into proposed slots. A calendar outage never loses a
booking.

## Connecting Anthropic

Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Optionally override
`AI_MODEL_FAST` and `AI_MODEL_SMART`.

Settings → Integrations shows whether the AI is live or still on the mock, and
the AI page shows run counts, success rate, latency and estimated spend.

---

## Health and observability

- `GET /api/health` — database connectivity plus the effective mode of each
  integration. Returns 503 when the database is unreachable. Point your uptime
  monitor here.
- Logs are structured JSON with `request_id`, `organization_id`, `job_id`,
  `message_id`, `provider`, `latency_ms` and `error_code`. Secrets and message
  bodies are redacted — see the redaction list in `src/lib/core/logger.ts`.
- `ai_runs` records every model call with prompt version and cost.
- `audit_logs` records privileged actions.
- Settings → Queue shows pending, in-flight and dead-lettered jobs, with
  per-job retry.

## Backups

Everything lives in Postgres. Use your provider's point-in-time recovery. The
tables that matter most operationally are `messages`, `conversations`,
`contacts` and `pipeline_deals`; the append-only `activities` table is the
audit trail for how each prospect was worked.

## Upgrading

```bash
git pull
npm ci
npm run db:migrate     # migrations are additive and safe to re-run
npm run build
# restart app and worker
```

Roll the app before the worker, or together — they share a codebase and the
queue tolerates both versions running briefly.
