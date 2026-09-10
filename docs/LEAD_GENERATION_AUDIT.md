# Lead Generation + Calling — Repository Audit

**Date:** 2026-09-09
**Branch:** `claude/on-radar-ai-sms-sales-up2jof`
**Baseline before any change:** typecheck clean, lint clean, 64/64 tests passing, build succeeds.

---

## 1. What already exists

On Radar is a modular monolith: one Next.js 15 app, one worker process, one
Postgres database. 32 tables, 22 services, 3 provider abstractions, 16 pages.

### CRM / prospect models — **reuse, do not duplicate**

| Table | Role |
|---|---|
| `companies` | The business. Already carries the research fields lead-gen produces: `website`, `industry`, `city`, `province`, `googleReviews`, `googleRating`, `websiteQuality`, `adPresence`, `bookingSystemDetected`, `crmDetected`, `ownerName`, `personalizationHooks`, `researchSummary`, `researchPainPoints`, `researchConfidence`, `leadGenerationSignals`, `researchedAt`. |
| `contacts` | **This is the prospect table.** `status` is the prospect lifecycle enum (NEW → … → WON/LOST/DO_NOT_CONTACT), and `score` / `scoreBucket` / `scoreBreakdown` / `scoringVersion` are the ICP score. `source` records provenance. |
| `campaigns`, `campaignSteps`, `campaignVariants`, `campaignMemberships` | Outreach sequencing with weighted A/B variants. |
| `conversations`, `messages`, `messageEvents` | SMS threads and provider events. |
| `pipelineDeals` | Opportunities, carrying `campaignId` + `variantId` for revenue attribution. |
| `appointments` | Bookings, with a calendar provider abstraction. |
| `activities` | **Append-only timeline.** Already has an `activity_type` enum covering most events; calling adds to it rather than creating a parallel log. |
| `tasks` | Follow-ups. Callbacks become tasks. |
| `qualifications`, `aiSummaries`, `aiRuns`, `aiPrompts` | AI state, versioned prompts, per-run cost/latency logging. |
| `suppressionEntries` | Do-not-contact. Must gate calling as well as SMS. |

**Decision: lead generation writes into `companies` + `contacts`.** No second
prospect system. A new staging table holds raw discovery output and provenance
until a record is normalized and deduplicated; promotion then creates or merges
the company and contact.

### Existing abstractions — extend the pattern

`SmsProvider` (Twilio / Telnyx / Mock), `AiProvider` (Anthropic / Mock),
`CalendarProvider` (Google / Internal). All follow the same shape: an interface,
real adapters, a working in-process mock, and a factory that falls back to the
mock when credentials are absent. `LeadDiscoveryProvider`, `EnrichmentProvider`
and `CallProvider` follow it exactly.

### Core logic already available

`lib/core/phone.ts` — NANP normalization to E.164, `normalizeEmail`,
`normalizeName`, `companyKey` (suffix-stripped comparison key, already used for
company dedupe on import). `lib/core/scoring.ts` — the configurable, transparent
rule engine with per-rule reasons. `lib/core/template.ts`, `csv.ts`, `time.ts`,
`intent.ts`. All pure and unit tested; the lead pipeline reuses them rather than
re-implementing normalization.

---

## 2. What does not exist

Searched the whole tree:

- **No calling functionality of any kind.** No `tel:` links, no call attempts,
  outcomes, dispositions, queues, or callbacks. Entirely new.
- **No lead discovery.** No scraper, no place ids, no search jobs.
- **No website crawling or technology detection.**
- **No generic job queue.** `outbound_jobs` exists but is SMS-specific:
  `message_id` and `conversation_id` are both `NOT NULL` with foreign keys, so
  it cannot carry a website-enrichment or discovery job without being gutted.
  A separate typed `lead_jobs` table is warranted; the SMS queue keeps its
  strict shape. Both are drained by the same worker tick.

---

## 3. Scraper reference — license finding

`Youssefanalyst/google-maps-scraper-actor-ts` was inspected as instructed.

- **No LICENSE file.** Under default copyright that is all rights reserved, so
  **no code from it may be incorporated.** Reference only.
- Architecture: Apify SDK v3 + Crawlee `PlaywrightCrawler` + headless Chromium,
  driving the Google Maps UI (tiling, sidebar scrolling, detail extraction).
  Built for Apify Store monetization.

**Decision.** The default discovery adapter is `GooglePlacesProvider`, using the
official Google Places API (New). It returns precisely the fields §8 asks for —
name, national/international phone, website, address components, rating,
user rating count, place id, lat/lng, opening hours, types — without scraping
anyone's UI, and it is the path that stays inside Google's terms.

The `LeadDiscoveryProvider` interface deliberately leaves room for a
browser-automation adapter; the useful ideas from the reference (geographic
tiling to beat the 60-result cap, bounded pagination, per-domain concurrency)
are noted in the interface docs and applied to the Places adapter where they
transfer. Anyone who wants the scraping path can add an adapter without touching
business logic.

---

## 4. Required schema additions

New, because no equivalent exists:

| Table | Why |
|---|---|
| `lead_search_jobs` | A durable search with counts and lifecycle. |
| `lead_discovery_records` | Raw provider payload + normalized fields + dedupe decision, before promotion. Preserves provenance permanently. |
| `saved_searches` | Reusable search definitions. |
| `lead_jobs` | Generic typed background work (discovery, enrichment, research, scoring, personalization). |
| `lead_enrichment` | Versioned enrichment output per company, with content hashing for cost control. |
| `lead_signals` | Individual detected signals with source and evidence. |
| `duplicate_matches` | Why two records were considered the same. Nothing is silently deleted. |
| `call_queues`, `call_queue_items` | Persisted queues with position, so a browser reload does not lose progress. |
| `call_attempts` | One row per call, distinguishing `CALL_INITIATED` from any `CONNECTED` state. |

Extended, not replaced: `companies` gains provenance and quality columns;
`contacts` gains call-state columns; the `activity_type` enum gains call events.

---

## 5. Technical risks

| Risk | Mitigation |
|---|---|
| Claiming a call connected when using `tel:` | The app only ever knows the operator *clicked*. `call_attempts.outcome` starts at `INITIATED`; connection states are only recorded when a voice provider supplies them, or when the human explicitly marks them. Analytics label connect rate as operator-reported. |
| Scraped pages as prompt injection | Page text is passed to the model only inside a clearly delimited untrusted block, with the extraction contract stated as system instruction, and output validated by Zod. The agent is told that page content is data, never instructions. |
| Unbounded crawling | Bounded page list per site, per-domain concurrency of 1, global concurrency cap, byte cap, timeout, and `robots.txt` respected. |
| Cost blowout on enrichment | Content hashing plus a 30-day cache; research is not re-run unless content changed or a refresh is requested. |
| Duplicate prospects | Five-tier match hierarchy (place id → phone → domain → email → name+address), recorded in `duplicate_matches` rather than deleted. |
| Calling a suppressed number | The same suppression list that gates SMS gates queue building and the call screen. |
| Tenant leakage | Every new table carries `organization_id`; every new service takes the existing `Ctx` as its first argument. |

---

## 6. Implementation plan

Phase 1 schema → 2 search jobs → 3 discovery adapter → 4 normalize/dedupe →
5 website enrichment → 6 signals/contacts → 7 AI research → 8 ICP scoring →
9 personalization → 10 review UI → 11 call queue → 12 call view → 13 dispositions
→ 14 analytics → 15 campaign integration → 16 AI integration → 17 tests →
18 hardening. Typecheck, lint, tests and build after each.

---

## 7. What the build actually found

The plan above survived contact with the code, with four exceptions worth
recording — each was a bug the audit did not predict, and three of them were
invisible to the test suite that existed at the time.

### 7.1 Correlated subqueries that silently counted zero

Drizzle renders a column in the **SELECT-field** position without its table
qualifier when the outer query has no join. So this:

```ts
remaining: sql<number>`(
  select count(*)::int from ${callQueueItems} i
  where i.queue_id = ${callQueues.id} and i.status in ('PENDING','CURRENT')
)`
```

emits `where i.queue_id = "id"`, and `"id"` resolves against
`call_queue_items` — the subquery correlated a table with itself. It returned
zero instead of raising. The same shape was wrong in `listCampaigns` and
`campaignPerformance`, so **every prospect, sent and reply count on the
campaigns and analytics pages had been zero**, on screens that looked fine.

In a WHERE clause, and in any query that has a join, drizzle *does* qualify —
which is why this was inconsistent and easy to miss.

Fix: `outer()` in `src/lib/db/sql.ts` always emits `"table"."column"`, and it
is applied to every correlated subquery, including the ones that are correct
today only because their query happens to have a join. Two regression tests
cover the class; both fail without the fix.

**Found by loading the page in a browser**, not by any test, typecheck, lint or
build — the same way the `buttonClass` bug was found in the previous build.

### 7.2 The research agent was reading almost nothing

The crawler produced readable page text and discarded it: only the title, meta
description and services were stored in `lead_enrichment.output`. The research
prompt's untrusted-content fence was guarding a nearly empty block.

Found while writing the prompt-injection test — the hostile page's content
never appeared in the prompt, because no page text ever did. A capped excerpt
is now stored and passed through.

### 7.3 A disposition that dropped the thing it was recording

`recordDisposition` skipped the contact update entirely for `WRONG_NUMBER` and
`BAD_NUMBER`, on the theory that suppression had already written the row.
Suppression only sets `status`, so `phoneInvalid`, `phoneValidated` and
`phoneConfidence` were computed and thrown away — and the number stayed
dialable. The patch never touches `status`, so it is safe to always apply.

### 7.4 A test that passed for the wrong reason

"Excludes suppressed numbers from queues" asserted only that the suppressed
contact was absent. An empty queue satisfies that. It now also asserts the
queue contains every *other* lead, so a queue that comes back empty for an
unrelated reason fails instead of passing.

---

## 8. What was built, against the plan

Every phase landed. Notes where reality differed:

- **Discovery provider**: `GooglePlacesProvider` is the default adapter, as the
  audit concluded (§2). The reference repo has no LICENSE file, so it was read
  and not copied.
- **`contacts` is the prospect table.** No parallel prospect store was created.
  A lead is a `contacts` row; the lead inbox is a view over the CRM; approving
  a lead does not move it anywhere.
- **Calling honours §107 throughout.** `INITIATED` is the only outcome the
  system writes on its own. `call_attempts.connection_reported` is false unless
  a provider says otherwise, and it is false for every call today. The call
  screen, the calls page, the analytics panel and Settings → Integrations all
  say so in words rather than implying a connect rate.
- **Demo data runs the real pipeline.** `npm run db:seed` drives discovery,
  enrichment, research, scoring and personalization against the synthetic
  provider rather than inserting rows that mimic their output — data that
  skipped the pipeline would hide exactly the bugs a demo should surface.

---

## 9. The scraper, built out

The first pass built the pipeline's skeleton and the screens around it. This
pass made the discovery and crawling half real.

### 9.1 The crawler reads the site, not a list of guesses

It fetched eleven hardcoded paths. It now fetches the homepage, reads the
site's own navigation, classifies each link by what it is likely to answer
(services, contact, quote, about, service area, pricing), ranks them, and
fetches one page per role before any second page of the same role. Assets,
legal pages and blog archives never cost a request. On the synthetic corpus
this finds `/our-services`, `/meet-the-team`, `/get-in-touch`,
`/request-an-estimate` and `/areas-we-serve` — none of which a fixed path list
would have found.

Every URL considered is recorded with the outcome and the reason, and that
trail is rendered in the admin panel.

### 9.2 Content is kept, per page

The QA finding (§7.2) is fixed at the root rather than patched. Each crawled
page is stored normalized — url, role, title, headings, text — on a budget
spread across the pages rather than spent on whichever came first. The research
agent assembles its prompt from those pages, each section headed by the URL it
came from, so a claim in the output can be traced to a page an operator can
open. The untrusted-content fence is unchanged and now states that the block is
per-page scraped content and that text claiming the block has ended is part of
the data.

### 9.3 Signals became qualification, not inventory

Technology detection said what was on the site. The added layer says why the
business is worth a call: outdated site, missing CTA, no lead form, no booking
flow, weak contact experience, no follow-up mechanism, paying for traffic,
spending without conversion, high-value services, large service area,
emergency work.

Each carries its evidence, the URL that evidence is on, and an `inferred` flag,
because these are judgements drawn from observations rather than observations.
Absence stays absence: a signal that could not be established is
`detected: false` with null evidence, and the UI says so in words — "No
evidence found for … That is not proof they lack it."

### 9.4 The synthetic world got websites

The mock provider invents businesses on `.example`, which RFC 2606 guarantees
cannot resolve. The consequence was that a demo discovered 190 businesses and
crawled none: the crawler, extractor, signal detector and research agent all
idle behind failed fetches, and a lead inbox full of records nothing had ever
looked at.

`syntheticFetch` serves those businesses a generated site — deterministic per
host, varied enough that signal detection has hits and misses, some
deliberately dead. Its safety is structural, not careful: it throws for any
host not under `.example`, and it is wired in only when the *discovery*
provider is the mock one. A configured provider always crawls the real
internet.

### 9.5 A misconfigured provider is an error, not a silent downgrade

`getDiscoveryProvider()` used to fall back to synthetic data when
`google_places` was selected without a key. A misconfigured production
deployment would have looked like a working one and filled a real call queue
with fictional businesses on 555 numbers. It now throws with the variable name
and the way out, and the lead-generation page reports it instead of running.

### 9.6 More bugs the tests and the browser found

| Found by | Bug |
|---|---|
| Writing the signal tests | `BOOKING_HOSTS` matched `book.` anywhere in a URL, and `facebook.com` contains it — so any business with a Facebook link was recorded as having online booking, inflating its website quality score and suppressing `no_online_booking`. |
| Loading a lead in a browser | Service areas were read out of the navigation menu: nav link text runs together into "… Service Areas … Privacy", and "Privacy" was stored as a town the business serves. |
| Browser console | `/prospects` discarded and rebuilt its React tree on every load — a relative timestamp rendered server-side and rehydrated client-side across a minute boundary. |
