# On Radar

**AI-powered outbound sales operating system.**

Turns a targeted prospect list into personalized SMS conversations, AI
qualification, human handoff, booked appointments, and measurable revenue.

Not an SMS sender. A sales development platform: CRM, outreach sequencing,
conversation intelligence, appointment booking and revenue attribution in one
modular monolith.

---

## The loop

```
prospects → enrichment → scoring → personalization → campaign
    → SMS sequence → inbound reply → AI conversation → qualification
    → human handoff when needed → appointment → pipeline → revenue → analytics
```

Every arrow in that chain is implemented, tested end to end, and visible in the
UI. Nothing on any screen is a mockup.

---

## Quick start

Requires **Node 20 or newer**. Nothing else — no Postgres, no Docker, no
credentials.

```bash
git clone https://github.com/Sachit96/Leadgen.git on-radar
cd on-radar
git checkout claude/on-radar-ai-sms-sales-up2jof

npm install
npm run setup      # writes .env, creates the database, loads demo data
npm run dev        # http://localhost:3000
```

`npm run setup` prints the sign-in credentials it created (by default
`owner@onradar.local` / `onradar-demo-2026`).

> If you already have a folder called `Leadgen`, clone into a different name as
> above — `git clone` refuses to write into a non-empty directory, and because
> the commands are chained, nothing after it would run.

**Why there is no database to install.** `setup` points `DATABASE_URL` at
`pglite://./data/onradar` — an embedded Postgres engine that writes to a local
directory. It is the same engine the test suite runs the real migrations
against, so the SQL, constraints and indexes are identical to a served Postgres.
It is single-process, so demo mode runs the worker inside the app rather than as
a separate `npm run worker`; `npm run dev` on its own is a complete system.

For anything beyond a local demo, point `DATABASE_URL` at a real Postgres
(Supabase, Neon, RDS) and run the worker as its own process:

```bash
DATABASE_URL='postgres://…' npm run db:migrate
npm run start      # the app
npm run worker     # the worker, in a second terminal
```

With no third-party credentials the app runs fully on mocks: the SMS provider,
the AI provider and the calendar all have real in-process implementations of the
same interfaces. The queue, delivery tracking, guardrails, conversation engine
and analytics all behave exactly as they will in production — no message reaches
a real phone, and Settings → Integrations always shows which mode each
integration is actually in.

### Demo mode

`npm run db:seed` creates six researched contractor companies (roofing, HVAC,
plumbing, landscaping), scored prospects, five live conversations with real
transcripts, a booked appointment, a completed call and a won deal. The
dashboard, funnel, campaign table and variant results on first load are computed
from those rows — none of it is hardcoded.

---

## Architecture

A modular monolith: one Next.js app, one worker process, one Postgres database.

```
src/
  app/                    Pages, server actions, API routes
  components/             UI primitives and feature components
  lib/
    constants/            Enum values shared by the schema and the client
    core/                 Pure logic: scoring, phone, templating, intent, time, CSV
    db/                   Drizzle schema, typed models, connection handle
    auth/                 Sessions, password hashing, request context, RBAC
    services/             All business logic. The only layer that touches the DB.
    providers/
      sms/                SmsProvider + Twilio / Telnyx / Mock
      ai/                 AiProvider + Anthropic / Mock
      calendar/           CalendarProvider + Google / Internal
    agents/               Stateful AI SDR: prompts, schemas, orchestration
    worker/               The background tick
drizzle/                  Generated SQL migrations + optional RLS policies
scripts/                  migrate / seed / reset / worker
tests/                    Unit, integration and end-to-end (PGlite-backed)
docs/                     Architecture audit, deployment guide
```

**Layering rules**, visible in the imports:

1. `lib/core/**` imports nothing from the app. Pure, exhaustively unit tested.
2. `lib/services/**` is the only layer that touches the database. Every export
   takes a `Ctx` (organization + user + role) as its first argument, so tenant
   scoping is a function signature, not a convention.
3. `lib/providers/**` knows nothing about the database or business rules.
4. `app/**` never queries the database. Pages call services; forms call server
   actions; server actions call services.
5. AI lives behind `lib/agents/**` and always returns Zod-validated output.

Full rationale, including the decisions deliberately *not* taken, is in
[`docs/ARCHITECTURE_AUDIT.md`](docs/ARCHITECTURE_AUDIT.md).

---

## How the important parts work

### Nothing sends from a request

The UI writes a message row and a queue job, then returns. A worker claims jobs
with `FOR UPDATE SKIP LOCKED` and does the sending. Every guardrail is
re-evaluated at send time, not just at queue time — a job can sit in the queue
for hours, and a prospect who replied STOP in the meantime must not receive it.

Failures back off exponentially and dead-letter. Deferrals (quiet hours, daily
caps, per-contact cooldowns) reschedule rather than drop, and don't burn a retry.

### Opt-out never depends on the AI

STOP detection is deterministic string matching in `lib/core/intent.ts`,
evaluated before any model call. A suppression row blocks every future automated
send, stops the campaign membership, cancels queued jobs and closes the
conversation. Numbers that opted out themselves cannot be un-suppressed from the
UI — that consent is theirs to give back.

### The AI is a stateful SDR, not a chatbot

Each turn receives the conversation state, the full transcript, the *verified
facts* about the company, the qualification captured so far, and the knowledge
base. It returns structured output validated with Zod:

```json
{
  "message": "…",
  "conversation_state": "DISCOVERY",
  "intent": "positive",
  "confidence": 0.92,
  "lead_temperature": "warm",
  "next_action": "ask_followup",
  "qualification_updates": { "monthly_lead_volume": 45 },
  "requires_human": false
}
```

Unparsable output is retried once with a corrective instruction, then the
conversation goes to a human. A model never puts unvalidated text in front of a
prospect.

The prompt separates `VERIFIED FACTS` from explicitly named `UNKNOWN` fields, so
there is nothing to fabricate from. Pricing and guarantees come from Settings —
a blank guarantee field means the agent is told never to imply one.

**AI failure is contained.** A failed turn flags the conversation, notifies the
team, and leaves manual reply fully working. The AI is never a single point of
failure for the product.

### Cost control

Two model tiers: the fast model handles classification and easy turns, the
strong model handles objections, qualification and research. Company research is
cached for 30 days. Every run is logged to `ai_runs` with its prompt version,
model, latency, token counts and estimated cost.

### Revenue attribution

A deal carries the campaign and the message variant that opened the
conversation, so analytics answer *which message made money*, not just how much
came in. Variant results stay marked "too early" until 30 sends — scaling on a
reply rate from five messages is how a good angle gets killed.

---

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Writes .env, creates the database, loads demo data |
| `npm run dev` | Development server (also runs the worker, in demo mode) |
| `npm run worker` | Background worker: sequences, AI turns, sending, reminders |
| `npm run build` / `npm start` | Production build and serve |
| `npm run db:migrate` | Apply migrations |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:seed` | Seed demo data |
| `npm run db:reset` | Drop and rebuild (refuses in production) |
| `npm test` | Full test suite |
| `npm run typecheck` | TypeScript, strict |
| `npm run lint` | ESLint |
| `npm run verify` | typecheck + lint + tests |

## Tests

64 tests. They run the **real migrations** against in-process Postgres (PGlite)
with mock providers — real SQL, real constraints, real indexes, no Docker and no
credentials.

```bash
npm test
```

The end-to-end case drives CSV import → scoring → enrollment → sequence → send →
inbound reply → AI turn → qualification → booking → pipeline → analytics in a
single pass, plus opt-out, idempotency, provider failure, AI failure,
tenant isolation, webhook signature forgery and every sending guardrail.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Vercel, a single VPS, and
Docker, including how to run the worker in each and how to point Twilio's
webhooks at the app.

## License

Proprietary. © On Radar.
