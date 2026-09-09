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
