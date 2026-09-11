# Deploying to Netlify

## The one that will bite you

`npm run build` succeeds with **no environment variables at all**. Every page in
this app is `force-dynamic`, so nothing is prerendered and the environment
schema is never read during the build.

That means a deploy with no configuration goes green and then returns 500 on
every request:

```
Error: Invalid environment configuration:
  - SESSION_SECRET: Required
```

`netlify.toml` runs `npm run db:migrate` before `npm run build` for exactly this
reason: with no `DATABASE_URL` the deploy fails loudly instead of publishing a
broken site.

## The embedded database does not work here

`pglite://./data/onradar` writes to a local directory. Netlify functions are
ephemeral and their filesystem is read-only apart from `/tmp`, so an embedded
database would be empty on every invocation even if it could be written.

Use a hosted Postgres — Neon, Supabase and RDS all work. The app needs nothing
special from it:

```
DATABASE_URL=postgres://user:password@host/dbname
DATABASE_SSL=true
```

Never set `UI_PREVIEW=true` on a deployed environment. It supplies a default
`SESSION_SECRET`, which is only safe because it cannot be reached without the
flag, and its database is in-memory — every function invocation would get a
fresh, empty one.

## Required variables

Set these in **Site settings → Environment variables** before the first deploy.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your hosted Postgres connection string |
| `DATABASE_SSL` | `true` for Neon, Supabase, RDS |
| `SESSION_SECRET` | 32+ random characters — `openssl rand -base64 48` |
| `NEXT_PUBLIC_APP_URL` | `https://leadgen9981.netlify.app` — used to build webhook callback URLs, so it must match the URL your SMS provider actually posts to |
| `WORKER_TOKEN` | A long random string. Without it `/api/worker/tick` refuses every request rather than being left open |
| `DEMO_MODE` | `false`. It ticks the worker inside the app, which on serverless means per-invocation |

Optional, each falling back to a working in-process mock:

| Variable | Effect |
|---|---|
| `SMS_PROVIDER` + `TWILIO_*` / `TELNYX_*` | Real messages. Until then nothing reaches a phone |
| `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | Real agent output |
| `LEAD_DISCOVERY_PROVIDER=google_places` + `GOOGLE_PLACES_API_KEY` | Real business discovery. Selected without a key is a hard error, not a fallback |

Settings → Integrations shows which mode each one is actually in.

## The worker

`npm run worker` is a long-lived process and has nowhere to run on Netlify.
The same tick is exposed over HTTP for this case:

```
POST https://leadgen9981.netlify.app/api/worker/tick?token=$WORKER_TOKEN
```

Drive it from a Netlify Scheduled Function or any external scheduler. Nothing
sends, enriches or scores until something calls it.

## First deploy

1. Create the database and copy its connection string.
2. Set the variables above.
3. Deploy. The build migrates, then builds.
4. Create the first account at `/login` — signup creates the organization.
   There is no seeded demo data in production; `npm run db:seed` is a local
   convenience and is not run by the build.
