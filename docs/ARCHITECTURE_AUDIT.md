# Architecture Audit

**Date:** 2026-09-08
**Branch:** `claude/on-radar-ai-sms-sales-up2jof`
**Auditor:** Claude Code

---

## 1. Audit finding: the repository was empty

The build brief asked for an audit of the existing On Radar codebase before any
changes, explicitly to avoid destroying working functionality. That audit was
performed first, and the finding changes the shape of the work:

```
$ git log
fatal: your current branch 'claude/on-radar-ai-sms-sales-up2jof' does not have any commits yet

$ git ls-remote --heads origin
(no output — no branches on the remote)

$ ls -la /home/user/Leadgen
.git      <- only entry
```

There is **no** `package.json`, README, schema, migration, API route, component,
test, or deployment config. `Sachit96/Leadgen` is an initialized repository with
zero commits and zero remote branches.

Consequences for the brief:

| Brief instruction | Status |
|---|---|
| "Inspect the complete repository structure" | Done — the repository contains only `.git`. |
| "Run the current application / tests / typecheck / lint" | Not applicable — nothing to run. |
| "Identify existing bugs" | None exist. |
| "Preserve working functionality / reuse existing components" | Nothing to preserve. No risk of destroying prior work. |
| "Do not start from scratch until you have inspected the repository" | Inspection complete; starting from scratch is now the only option. |

Everything below is therefore a **greenfield architecture decision record**
rather than a report on inherited code.

---

## 2. What exists after this build

A modular monolith. One deployable Next.js application plus one background
worker process, sharing a single Postgres database and one service layer.

```
src/
  app/                      Next.js App Router — pages, server actions, API routes
  components/               UI primitives and feature components
  lib/
    core/                   Pure, dependency-free logic (scoring, phone, template, intent)
    db/                     Drizzle schema, typed models, connection handle
    auth/                   Sessions, password hashing, request context, RBAC
    services/               All business logic. The only layer that touches the DB.
    providers/
      sms/                  SmsProvider interface + Twilio / Telnyx / Mock adapters
      ai/                   AiProvider interface + Anthropic / Mock adapters
      calendar/             CalendarProvider interface + Google / Internal adapters
    agents/                 Stateful AI SDR: prompts, schemas, orchestration
drizzle/                    Generated SQL migrations + RLS policies
scripts/                    migrate / seed / reset / worker entrypoints
tests/                      Unit, integration and end-to-end suites (PGlite-backed)
docs/                       This audit, architecture notes, deployment guide
```

---

## 3. Stack decisions and why

| Concern | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 (App Router) + React 19 + TypeScript strict** | The brief's preferred architecture. Server Components keep prospect/inbox lists paginated on the server rather than shipping thousands of rows to the browser. |
| Database | **Postgres via Drizzle ORM** | Works against Supabase, Neon, RDS, or plain Postgres without code changes. Drizzle gives real SQL, typed results, and generated migrations — no hidden query magic to debug at 2am. |
| Migrations | **drizzle-kit generated SQL, applied by a script** | Reviewable SQL checked into `drizzle/`. Applied identically in tests and production. |
| Tests | **Vitest + PGlite (in-process Postgres)** | The test suite runs the *real* migrations against a *real* Postgres engine with no Docker, no service containers, and no credentials. Constraints and indexes are exercised, not mocked. |
| Auth | **First-party sessions: scrypt password hashing, HTTP-only cookies, server-side session table** | No external identity dependency for a single-tenant internal tool. Roles enforced server-side on every mutation. |
| Multi-tenancy | **`organization_id` on every owned row + a required `Ctx` on every service call** | Tenant scoping is a function-signature requirement, not a convention a caller can forget. RLS policies additionally provided for Supabase deployments. |
| Queue | **Postgres-backed job table with `FOR UPDATE SKIP LOCKED`** | The brief asks for durable outbound jobs with retries and idempotency, and explicitly warns against unnecessary infrastructure. Postgres already provides the locking primitive; adding Redis/BullMQ would be a second datastore for no gain at this volume. |
| Realtime | **Server-Sent Events over a cursor-based DB change feed** | Survives restarts and multiple app instances, needs no vendor realtime service, and only the inbox/notification surfaces subscribe. |
| AI | **Provider interface with Anthropic + Mock adapters, two model tiers** | Cheap/fast model for classification and extraction, stronger model for live sales turns and research. Every call logged with prompt version and cost. |
| SMS | **`SmsProvider` interface with Twilio, Telnyx and Mock adapters** | No business logic imports Twilio. Swapping providers is a config change. |
| UI | **Tailwind CSS v4, hand-built components** | Dense dark SaaS surface without inheriting a component library's opinions or its dependency tree. |

### Deliberate non-choices

- **No microservices.** One app, one worker, one database.
- **No Redis.** The job queue, rate limits and cooldowns are Postgres rows.
- **No ORM-level RLS reliance for correctness.** RLS is defence in depth; the
  service layer is the enforcement point, because the app connects as a
  privileged role in most deployments.
- **No component library.** Ten new frameworks is explicitly what the brief
  asks to avoid.

---

## 4. Layering rules

These are enforced by review, and violations are visible in imports:

1. `lib/core/**` imports nothing from the app. Pure functions, exhaustively unit tested.
2. `lib/services/**` is the only layer that touches the database. Every exported
   function takes a `Ctx` (organization + user + role) as its first argument.
3. `lib/providers/**` knows nothing about the database or business rules. It
   translates one vendor's API into a local interface, and back.
4. `app/**` never queries the database directly. Pages call services; forms call
   server actions; server actions call services.
5. AI lives behind `lib/agents/**` and always returns Zod-validated structured
   output. A model is never allowed to produce a message that is sent unchecked.

---

## 5. Risk register

| Risk | Mitigation in this build |
|---|---|
| AI outage stops all sales work | AI failure flags the conversation, notifies the operator, and leaves manual reply fully functional. AI is never on the critical path for reading or replying. |
| Malformed model output reaches a prospect | All AI turns parse through Zod; one retry, then a safe fallback that hands to a human. Nothing unparsed is ever sent. |
| Webhook retries duplicate messages | Provider event IDs are stored with a unique dedupe key; replays are recorded and discarded. |
| Double-sending on worker restart | Outbound jobs carry a unique idempotency key per org, and rows are claimed with `SKIP LOCKED`. |
| Opt-out failing to register | STOP detection is deterministic string matching in `lib/core/intent.ts`, evaluated before any model call, and writes a suppression row that blocks every future automated send. |
| Tenant leakage | `organization_id` predicate on every service query; RLS policies for Supabase; no client-supplied org identifiers are trusted. |
| Cost blowout on AI | Two-tier model routing, cached company research, per-run cost logging in `ai_runs`. |
