import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  companies,
  contacts,
  leadDiscoveryRecords,
  leadEnrichment,
  leadSearchJobs,
  leadSignals,
} from '@/lib/db/schema';
import { logger } from '@/lib/core/logger';
import { errorMessage } from '@/lib/core/errors';
import { systemCtx, type Ctx } from '@/lib/auth/context';
import { getDiscoveryProvider, DiscoveryError } from '@/lib/lead-generation/providers';
import { normalizeDiscoveredBusiness, type NormalizedLead } from '@/lib/lead-generation/normalize';
import { findDuplicate, recordDuplicate } from '@/lib/lead-generation/dedupe';
import { crawlWebsite } from '@/lib/enrichment/crawler';
import { extractSite } from '@/lib/enrichment/extract';
import {
  detectSignals,
  hasAdvertisingEvidence,
  hasWeakConversionInfrastructure,
  WEBSITE_QUALITY_VERSION,
} from '@/lib/enrichment/signals';
import { recordActivity } from './activity';
import { rescoreProspect } from './contacts';
import { isSuppressed } from './suppression';
import { bumpSearchCounter, completeSearchIfDone, getSearchJob } from './lead-search';
import { enqueueLeadJob, enqueueMany, type ClaimedLeadJob } from './lead-jobs';

/**
 * The lead pipeline.
 *
 * Each stage is a job the worker runs, so a slow crawl or a failing site never
 * blocks the batch, and every stage is independently retryable. Stages hand off
 * by enqueuing the next one, which keeps the flow explicit and restartable at
 * any point.
 */
/** Enough for the research agent; far short of a whole site. */
const MAX_STORED_PAGE_TEXT = 20_000;

export type StageResult =
  | { result: 'ok'; detail?: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; error: string; retryable: boolean; code?: string };

/* ------------------------------------------------------------- 1. discovery */

export async function runDiscovery(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.searchJobId) return { result: 'skipped', reason: 'no search job attached' };

  const ctx = systemCtx(job.organizationId);
  const search = await getSearchJob(ctx, job.searchJobId);
  if (search.status === 'CANCELLED') return { result: 'skipped', reason: 'search was cancelled' };

  const db = getDb();
  await db
    .update(leadSearchJobs)
    .set({ status: 'RUNNING' })
    .where(eq(leadSearchJobs.id, search.id));

  const provider = getDiscoveryProvider();

  try {
    const { businesses, truncated } = await provider.searchBusinesses({
      query: search.query,
      location: search.location,
      radiusMeters: search.radiusMeters,
      limit: search.requestedCount,
      filters: (search.filters ?? {}) as Record<string, never>,
    });

    if (businesses.length === 0) {
      await db
        .update(leadSearchJobs)
        .set({ status: 'COMPLETED', completedAt: new Date() })
        .where(eq(leadSearchJobs.id, search.id));
      return { result: 'ok', detail: 'no businesses matched' };
    }

    // Written in one statement; the unique index on (org, provider, external_id)
    // makes a re-run of the same search idempotent rather than duplicative.
    const inserted = await db
      .insert(leadDiscoveryRecords)
      .values(
        businesses.map((business) => {
          const normalized = normalizeDiscoveredBusiness(business);
          return {
            organizationId: ctx.organizationId,
            searchJobId: search.id,
            provider: provider.kind,
            externalId: normalized.externalId,
            stage: 'DISCOVERED' as const,
            raw: business.raw as Record<string, unknown>,
            businessName: normalized.businessName,
            nameKey: normalized.nameKey,
            phone: normalized.phone,
            phoneRaw: normalized.phoneRaw,
            website: normalized.website,
            websiteDomain: normalized.websiteDomain,
            addressLine: normalized.addressLine,
            city: normalized.city,
            province: normalized.province,
            postalCode: normalized.postalCode,
            country: normalized.country,
            category: normalized.category,
            categories: normalized.categories,
            googleRating: normalized.rating,
            googleReviewCount: normalized.reviewCount,
            latitude: normalized.latitude,
            longitude: normalized.longitude,
            hours: normalized.hours,
            socialUrls: normalized.socialUrls,
            sourceUrl: normalized.sourceUrl,
          };
        }),
      )
      .onConflictDoNothing()
      .returning({ id: leadDiscoveryRecords.id, businessName: leadDiscoveryRecords.businessName });

    await bumpSearchCounter(search.id, 'discoveredCount', inserted.length);

    // One normalization job per record, so a bad record fails alone.
    await enqueueMany(
      ctx,
      inserted.map((record) => ({
        type: 'lead_normalization' as const,
        idempotencyKey: `normalize:${record.id}`,
        searchJobId: search.id,
        discoveryRecordId: record.id,
        priority: 2,
      })),
    );

    await recordActivity(ctx, {
      type: 'business_discovered',
      title: `Discovered ${inserted.length} businesses for "${search.query}" in ${search.location}`,
      metadata: {
        searchJobId: search.id,
        discovered: inserted.length,
        returned: businesses.length,
        truncated,
        provider: provider.kind,
      },
    });

    return { result: 'ok', detail: `${inserted.length} new of ${businesses.length} returned` };
  } catch (error) {
    const discoveryError = error instanceof DiscoveryError ? error : null;
    await db
      .update(leadSearchJobs)
      .set({ status: 'FAILED', error: errorMessage(error).slice(0, 500), completedAt: new Date() })
      .where(eq(leadSearchJobs.id, search.id));

    return {
      result: 'failed',
      error: errorMessage(error),
      retryable: discoveryError?.retryable ?? false,
      code: discoveryError?.code,
    };
  }
}

/* --------------------------------- 2. normalize, deduplicate, promote to CRM */

export async function runNormalization(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.discoveryRecordId) return { result: 'skipped', reason: 'no discovery record' };

  const ctx = systemCtx(job.organizationId);
  const db = getDb();

  const rows = await db
    .select()
    .from(leadDiscoveryRecords)
    .where(eq(leadDiscoveryRecords.id, job.discoveryRecordId))
    .limit(1);
  const record = rows[0];
  if (!record) return { result: 'skipped', reason: 'record no longer exists' };
  if (record.companyId) return { result: 'skipped', reason: 'already promoted' };

  const lead: NormalizedLead = {
    businessName: record.businessName,
    nameKey: record.nameKey,
    phone: record.phone,
    phoneRaw: record.phoneRaw,
    phoneValid: Boolean(record.phone),
    email: record.email,
    website: record.website,
    websiteDomain: record.websiteDomain,
    addressLine: record.addressLine,
    city: record.city,
    province: record.province,
    postalCode: record.postalCode,
    country: record.country,
    category: record.category,
    categories: (record.categories as string[]) ?? [],
    rating: record.googleRating,
    reviewCount: record.googleReviewCount,
    latitude: record.latitude,
    longitude: record.longitude,
    hours: (record.hours as string[]) ?? null,
    socialUrls: (record.socialUrls as Record<string, string>) ?? {},
    sourceUrl: record.sourceUrl,
    externalId: record.externalId,
  };

  const duplicate = await findDuplicate(ctx, lead);
  if (duplicate.isDuplicate && duplicate.companyId) {
    await recordDuplicate(ctx, duplicate, record.id);
    await db
      .update(leadDiscoveryRecords)
      .set({
        stage: 'DUPLICATE',
        duplicateOfCompanyId: duplicate.companyId,
        duplicateReason: duplicate.reason,
        duplicateScore: duplicate.score,
      })
      .where(eq(leadDiscoveryRecords.id, record.id));

    if (record.searchJobId) await bumpSearchCounter(record.searchJobId, 'duplicateCount');
    return { result: 'ok', detail: `duplicate via ${duplicate.reason}` };
  }

  // Promote into the existing CRM: one company, and a contact when we have a
  // number to call. No parallel prospect table.
  const [company] = await db
    .insert(companies)
    .values({
      organizationId: ctx.organizationId,
      name: lead.businessName,
      nameKey: lead.nameKey,
      website: lead.website,
      websiteDomain: lead.websiteDomain,
      industry: lead.category,
      city: lead.city,
      province: lead.province,
      country: lead.country ?? 'Canada',
      postalCode: lead.postalCode,
      addressLine: lead.addressLine,
      latitude: lead.latitude,
      longitude: lead.longitude,
      categories: lead.categories,
      hours: lead.hours,
      googleRating: lead.rating,
      googleReviews: lead.reviewCount,
      externalId: lead.externalId,
      discoverySource: record.provider,
      sourceUrl: lead.sourceUrl,
    })
    .onConflictDoNothing()
    .returning();

  if (!company) {
    // Lost a race with a concurrent promotion of the same external id.
    return { result: 'skipped', reason: 'company was created concurrently' };
  }

  let contactId: string | null = null;
  if (lead.phone) {
    const suppressed = await isSuppressed(ctx, lead.phone);
    const [contact] = await db
      .insert(contacts)
      .values({
        organizationId: ctx.organizationId,
        companyId: company.id,
        phone: lead.phone,
        phoneRaw: lead.phoneRaw,
        status: suppressed ? 'DO_NOT_CONTACT' : 'NEW',
        source: `lead_gen:${record.provider}`,
        // The provider listed this number for this business; the crawler
        // corroborating it on their own site raises this later.
        phoneConfidence: 0.7,
        phoneValidated: true,
        callReadiness: 'NOT_READY',
      })
      .onConflictDoNothing()
      .returning();
    contactId = contact?.id ?? null;
  }

  await db
    .update(leadDiscoveryRecords)
    .set({ stage: 'NORMALIZED', companyId: company.id, contactId, promotedAt: new Date() })
    .where(eq(leadDiscoveryRecords.id, record.id));

  if (record.searchJobId) await bumpSearchCounter(record.searchJobId, 'uniqueCount');

  // Website enrichment when there is a site; otherwise straight to research,
  // which still has the Maps data to work with.
  await enqueueLeadJob(ctx, {
    type: lead.website ? 'website_enrichment' : 'ai_research',
    idempotencyKey: `${lead.website ? 'enrich' : 'research'}:${company.id}`,
    searchJobId: record.searchJobId,
    discoveryRecordId: record.id,
    companyId: company.id,
    contactId,
    priority: 3,
  });

  return { result: 'ok', detail: contactId ? 'promoted with contact' : 'promoted without phone' };
}

/* ------------------------------------------------ 3. website enrichment */

export async function runWebsiteEnrichment(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.companyId) return { result: 'skipped', reason: 'no company' };

  const ctx = systemCtx(job.organizationId);
  const db = getDb();

  const rows = await db.select().from(companies).where(eq(companies.id, job.companyId)).limit(1);
  const company = rows[0];
  if (!company) return { result: 'skipped', reason: 'company no longer exists' };
  if (!company.website) return { result: 'skipped', reason: 'no website to crawl' };

  await db
    .update(leadDiscoveryRecords)
    .set({ stage: 'ENRICHING' })
    .where(
      and(
        eq(leadDiscoveryRecords.companyId, company.id),
        eq(leadDiscoveryRecords.organizationId, ctx.organizationId),
      ),
    );

  const crawl = await crawlWebsite(company.website);

  if (!crawl.ok) {
    // A site that will not load is a real finding about the business, not a
    // pipeline failure — record it and carry on to research.
    await db.insert(leadEnrichment).values({
      organizationId: ctx.organizationId,
      companyId: company.id,
      kind: 'website',
      ok: false,
      input: { website: company.website },
      output: {},
      latencyMs: crawl.latencyMs,
      errorCode: crawl.errorCode,
      errorMessage: crawl.errorMessage,
    });

    await db
      .update(companies)
      .set({ websiteQuality: 'none', websiteQualityScore: 0, websiteQualityVersion: WEBSITE_QUALITY_VERSION })
      .where(eq(companies.id, company.id));

    await enqueueLeadJob(ctx, {
      type: 'ai_research',
      idempotencyKey: `research:${company.id}`,
      searchJobId: job.searchJobId,
      discoveryRecordId: job.discoveryRecordId,
      companyId: company.id,
      contactId: job.contactId,
      priority: 4,
    });

    return { result: 'ok', detail: `website unreachable (${crawl.errorCode})` };
  }

  // Unchanged content means nothing new to learn; skip the expensive stages.
  if (company.contentHash && company.contentHash === crawl.contentHash) {
    return { result: 'skipped', reason: 'website unchanged since last enrichment' };
  }

  const site = extractSite(crawl.pages);
  const { signals, quality, qualityScore } = detectSignals(crawl.pages, site, crawl.origin);

  const version = await nextEnrichmentVersion(company.id, 'website');
  await db.insert(leadEnrichment).values({
    organizationId: ctx.organizationId,
    companyId: company.id,
    kind: 'website',
    version,
    ok: true,
    contentHash: crawl.contentHash,
    input: { website: company.website, paths: crawl.pages.map((p) => p.path) },
    output: {
      title: site.title,
      description: site.description,
      services: site.services,
      emails: site.emails,
      phones: site.phones,
      socialUrls: site.socialUrls,
      bookingLinks: site.bookingLinks,
      quality,
      // The readable page text, capped. Research reads this; without it the
      // agent only ever saw the title and meta description and had almost
      // nothing to work from. Already stripped of scripts, styles and markup,
      // and still treated as untrusted where it reaches the model.
      text: site.text.slice(0, MAX_STORED_PAGE_TEXT),
    },
    pagesFetched: crawl.pages.length,
    bytesFetched: crawl.bytesFetched,
    latencyMs: crawl.latencyMs,
  });

  // The ICP in one line: they are paying to generate leads and have nothing on
  // the site to convert them. Derived rather than observed, so it is stored as
  // an inferred signal with the observations it was drawn from as evidence.
  const weakConversion = hasWeakConversionInfrastructure(quality, signals);
  signals.push({
    key: 'weak_conversion_infrastructure',
    category: 'conversion',
    detected: weakConversion,
    value: weakConversion ? 'no crm, booking flow or chat widget found' : null,
    confidence: 0.5,
    evidence: weakConversion
      ? `no CRM tag, booking flow or chat widget across ${crawl.pages.length} pages`
      : null,
    source: 'derived',
    inferred: true,
  });

  // Signals are upserted per company+key so the latest crawl wins without
  // losing the row's identity.
  for (const signal of signals) {
    await db
      .insert(leadSignals)
      .values({
        organizationId: ctx.organizationId,
        companyId: company.id,
        key: signal.key,
        category: signal.category,
        value: signal.value ?? null,
        detected: signal.detected,
        confidence: signal.confidence,
        evidence: signal.evidence,
        source: signal.source,
        inferred: signal.inferred,
      })
      .onConflictDoUpdate({
        target: [leadSignals.companyId, leadSignals.key],
        set: {
          detected: signal.detected,
          value: signal.value ?? null,
          confidence: signal.confidence,
          evidence: signal.evidence,
          createdAt: new Date(),
        },
      });
  }

  const crmSignal = signals.find((s) => s.key === 'field_service_crm' || s.key === 'marketing_crm');
  const socialUrls = site.socialUrls;

  await db
    .update(companies)
    .set({
      websiteQualityScore: qualityScore,
      websiteQualityVersion: WEBSITE_QUALITY_VERSION,
      websiteQuality: qualityScore >= 75 ? 'strong' : qualityScore >= 45 ? 'adequate' : 'weak',
      // Only asserted because a tag was actually found.
      adPresence: hasAdvertisingEvidence(signals),
      bookingSystemDetected: quality.has_booking_flow,
      crmDetected: crmSignal?.detected ? (crmSignal.value ?? 'detected') : null,
      facebookUrl: socialUrls.facebook ?? null,
      instagramUrl: socialUrls.instagram ?? null,
      linkedinUrl: socialUrls.linkedin ?? null,
      leadGenerationSignals: signals.filter((s) => s.detected).map((s) => s.value ?? s.key),
      contentHash: crawl.contentHash,
      enrichedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, company.id));

  // A number found on the business's own site corroborates the provider's.
  if (job.contactId && site.phones.length > 0) {
    const contactRows = await db.select().from(contacts).where(eq(contacts.id, job.contactId)).limit(1);
    const contact = contactRows[0];
    if (contact && site.phones.includes(contact.phone)) {
      await db
        .update(contacts)
        .set({ phoneConfidence: 0.95 })
        .where(eq(contacts.id, job.contactId));
    }
  }

  await db
    .update(leadDiscoveryRecords)
    .set({ stage: 'ENRICHED' })
    .where(eq(leadDiscoveryRecords.companyId, company.id));

  if (job.searchJobId) await bumpSearchCounter(job.searchJobId, 'enrichedCount');

  await recordActivity(ctx, {
    type: 'enrichment_completed',
    title: `Website enriched: ${company.name}`,
    body: site.description ?? null,
    metadata: {
      companyId: company.id,
      pages: crawl.pages.length,
      qualityScore,
      signalsDetected: signals.filter((s) => s.detected).length,
    },
  });

  await enqueueLeadJob(ctx, {
    type: 'ai_research',
    idempotencyKey: `research:${company.id}`,
    searchJobId: job.searchJobId,
    discoveryRecordId: job.discoveryRecordId,
    companyId: company.id,
    contactId: job.contactId,
    priority: 4,
  });

  return { result: 'ok', detail: `${crawl.pages.length} pages, quality ${qualityScore}` };
}

async function nextEnrichmentVersion(companyId: string, kind: string): Promise<number> {
  const rows = await getDb()
    .select({ version: sql<number>`coalesce(max(${leadEnrichment.version}), 0)::int` })
    .from(leadEnrichment)
    .where(and(eq(leadEnrichment.companyId, companyId), eq(leadEnrichment.kind, kind)));
  return (rows[0]?.version ?? 0) + 1;
}

/* ------------------------------------------------------------ 4. scoring */

export async function runScoring(job: ClaimedLeadJob): Promise<StageResult> {
  if (!job.contactId) return { result: 'skipped', reason: 'no contact to score' };

  const ctx = systemCtx(job.organizationId);
  const db = getDb();

  const result = await rescoreProspect(ctx, job.contactId);

  await db
    .update(leadDiscoveryRecords)
    .set({ stage: 'SCORED' })
    .where(eq(leadDiscoveryRecords.contactId, job.contactId));

  if (job.searchJobId) await bumpSearchCounter(job.searchJobId, 'scoredCount');

  await refreshCallReadiness(ctx, job.contactId);

  await enqueueLeadJob(ctx, {
    type: 'personalization_generation',
    idempotencyKey: `personalize:${job.contactId}`,
    searchJobId: job.searchJobId,
    discoveryRecordId: job.discoveryRecordId,
    companyId: job.companyId,
    contactId: job.contactId,
    priority: 6,
  });

  return { result: 'ok', detail: `scored ${result.score} (${result.bucket})` };
}

/**
 * Recomputes call readiness and data completeness.
 *
 * A lead is only callable with a valid phone, a company, an industry, a
 * location and a score — the app should never put a half-known record in front
 * of someone who is about to dial.
 */
export async function refreshCallReadiness(ctx: Ctx, contactId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) return;
  const { contact, company } = row;

  const completeness = dataCompleteness(contact, company);

  const blocked =
    contact.phoneInvalid ||
    contact.status === 'DO_NOT_CONTACT' ||
    (await isSuppressed(ctx, contact.phone));

  const ready =
    !blocked &&
    Boolean(contact.phone) &&
    contact.phoneValidated &&
    Boolean(company?.name) &&
    Boolean(company?.industry) &&
    Boolean(company?.city) &&
    contact.score !== null;

  // Never downgrade a lead that is already in a queue or has been worked.
  const terminal: string[] = ['QUEUED', 'CALLED', 'CALLBACK', 'COMPLETED'];
  const next = terminal.includes(contact.callReadiness)
    ? contact.callReadiness
    : ready
      ? 'READY'
      : 'NOT_READY';

  await db
    .update(contacts)
    .set({ callReadiness: next, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));

  if (company) {
    await db.update(companies).set({ dataCompleteness: completeness }).where(eq(companies.id, company.id));
  }
}

/** 0-100: how much of the record is actually known. */
export function dataCompleteness(
  contact: { phone: string | null; email: string | null; score: number | null },
  company: {
    name?: string | null;
    website?: string | null;
    city?: string | null;
    industry?: string | null;
    ownerName?: string | null;
    googleReviews?: number | null;
    researchSummary?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
  } | null,
): number {
  const checks: Array<[boolean, number]> = [
    [Boolean(company?.name), 12],
    [Boolean(contact.phone), 18],
    [Boolean(company?.website), 12],
    [Boolean(company?.city), 8],
    [Boolean(company?.industry), 8],
    [Boolean(company?.ownerName), 12],
    [Boolean(contact.email), 8],
    [Boolean(company?.facebookUrl || company?.instagramUrl || company?.linkedinUrl), 6],
    [Boolean(company?.googleReviews), 6],
    [Boolean(company?.researchSummary), 5],
    [contact.score !== null, 5],
  ];

  return checks.reduce((total, [met, weight]) => total + (met ? weight : 0), 0);
}

/** Called after every job so a search closes itself once nothing is pending. */
export async function finalizeSearchIfDone(job: ClaimedLeadJob): Promise<void> {
  if (!job.searchJobId) return;
  try {
    await completeSearchIfDone(job.searchJobId);
  } catch (error) {
    logger.warn('failed to finalize search', {
      organizationId: job.organizationId,
      errorCode: errorMessage(error).slice(0, 120),
    });
  }
}
