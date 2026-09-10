import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts, leadEnrichment, leadSignals } from '@/lib/db/schema';
import { normalizeEmail } from '@/lib/core/phone';
import type { Ctx } from '@/lib/auth/context';
import { isSuppressed } from './suppression';

/**
 * Contact enrichment.
 *
 * A discovery provider gives you the business's main number and nothing else.
 * The business's own site usually gives you more: a second number, a public
 * enquiry address, sometimes a named owner. This stage promotes what the crawl
 * already found onto the prospect record, with the page it came from attached.
 *
 * Two rules shape it:
 *
 * - It only ever *adds*. A number or address a human typed is never
 *   overwritten by something scraped off a page.
 * - Corroboration is a real finding. A number the provider listed that also
 *   appears on the business's own website is worth more than one that does not,
 *   and that raises `phoneConfidence` rather than being asserted for free.
 */
export type ContactEnrichmentResult =
  | { result: 'enriched'; added: string[] }
  | { result: 'skipped'; reason: string };

/** Addresses that belong to a platform rather than the business. */
const GENERIC_EMAIL_HOSTS = ['sentry.io', 'wixpress.com', 'squarespace.com', 'godaddy.com'];

/** Ordered by how likely a human actually reads it. */
const MAILBOX_PRIORITY = ['info', 'contact', 'hello', 'office', 'sales', 'enquiries', 'inquiries', 'admin'];

function rankEmail(email: string): number {
  const mailbox = email.split('@')[0]?.toLowerCase() ?? '';
  const index = MAILBOX_PRIORITY.indexOf(mailbox);
  // A named mailbox (owner@) beats a generic one; unknown mailboxes sit between.
  if (index >= 0) return 100 - index;
  return 50;
}

export function pickBestEmail(emails: string[], domain: string | null): string | null {
  const usable = emails
    .map((email) => normalizeEmail(email))
    .filter((email): email is string => Boolean(email))
    .filter((email) => !GENERIC_EMAIL_HOSTS.some((host) => email.endsWith(`@${host}`)))
    // An address on the business's own domain is theirs; a gmail on their
    // contact page usually is too, but the domain match is stronger evidence.
    .sort((a, b) => {
      const domainScore = (email: string) => (domain && email.endsWith(`@${domain}`) ? 1000 : 0);
      return domainScore(b) + rankEmail(b) - (domainScore(a) + rankEmail(a));
    });

  return usable[0] ?? null;
}

export async function enrichContact(ctx: Ctx, contactId: string): Promise<ContactEnrichmentResult> {
  const db = getDb();

  const rows = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { result: 'skipped', reason: 'contact no longer exists' };
  const { contact, company } = row;
  if (!company) return { result: 'skipped', reason: 'no company to enrich from' };

  const enrichmentRows = await db
    .select()
    .from(leadEnrichment)
    .where(and(eq(leadEnrichment.companyId, company.id), eq(leadEnrichment.kind, 'website')))
    .orderBy(desc(leadEnrichment.version))
    .limit(1);

  const enrichment = enrichmentRows[0];
  if (!enrichment?.ok) return { result: 'skipped', reason: 'no successful crawl to enrich from' };

  const output = enrichment.output as {
    emails?: string[];
    phones?: string[];
    pages?: Array<{ url: string; role: string }>;
  };

  const contactPageUrl =
    output.pages?.find((page) => page.role === 'contact')?.url ??
    output.pages?.find((page) => page.role === 'home')?.url ??
    company.website;

  const added: string[] = [];
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  // --- email ---------------------------------------------------------------
  // Only fills a blank. An address a human entered is theirs, not ours to move.
  if (!contact.email) {
    const email = pickBestEmail(output.emails ?? [], company.websiteDomain);
    if (email) {
      patch.email = email;
      added.push('email');
      await recordSignal(ctx, company.id, {
        key: 'public_email_found',
        value: email,
        evidence: `published on the business's own site`,
        sourceUrl: contactPageUrl,
      });
    }
  }

  // --- phone corroboration -------------------------------------------------
  const sitePhones = output.phones ?? [];
  if (sitePhones.includes(contact.phone)) {
    // The provider listed it and the business publishes it. That is two
    // independent sources agreeing, which is what confidence should mean.
    if ((contact.phoneConfidence ?? 0) < 0.95) {
      patch.phoneConfidence = 0.95;
      added.push('phone corroborated');
    }
    await recordSignal(ctx, company.id, {
      key: 'phone_corroborated',
      value: contact.phone,
      evidence: 'the number the provider listed is published on the site',
      sourceUrl: contactPageUrl,
    });
  } else if (sitePhones.length > 0) {
    // A different number on their site is a finding, not a replacement: the
    // listing may be a tracking number, or the site may show a second line.
    await recordSignal(ctx, company.id, {
      key: 'alternate_phone_on_site',
      value: sitePhones[0]!,
      evidence: `site publishes ${sitePhones.slice(0, 3).join(', ')}, provider listed ${contact.phone}`,
      sourceUrl: contactPageUrl,
    });
  }

  // --- owner name ----------------------------------------------------------
  // Research writes companies.ownerName when it is confident. Split it onto the
  // prospect only when the name fields are still empty.
  if (!contact.firstName && !contact.lastName && company.ownerName) {
    const parts = company.ownerName.trim().split(/\s+/);
    patch.firstName = parts[0] ?? null;
    patch.lastName = parts.slice(1).join(' ') || null;
    added.push('owner name');
  }

  if (Object.keys(patch).length > 1) {
    await db.update(contacts).set(patch).where(eq(contacts.id, contact.id));
  }

  // Suppression can have landed between promotion and here.
  if (await isSuppressed(ctx, contact.phone)) {
    await db
      .update(contacts)
      .set({ status: 'DO_NOT_CONTACT', updatedAt: new Date() })
      .where(and(eq(contacts.id, contact.id), ne(contacts.status, 'DO_NOT_CONTACT')));
  }

  return added.length > 0
    ? { result: 'enriched', added }
    : { result: 'skipped', reason: 'nothing new on the site' };
}

/** Upserted like every other signal, so provenance is uniform. */
async function recordSignal(
  ctx: Ctx,
  companyId: string,
  input: { key: string; value: string; evidence: string; sourceUrl: string | null },
): Promise<void> {
  await getDb()
    .insert(leadSignals)
    .values({
      organizationId: ctx.organizationId,
      companyId,
      key: input.key,
      category: 'conversion',
      value: input.value,
      detected: true,
      confidence: 0.9,
      evidence: input.evidence,
      sourceUrl: input.sourceUrl,
      source: 'website',
      inferred: false,
    })
    .onConflictDoUpdate({
      target: [leadSignals.companyId, leadSignals.key],
      set: {
        value: input.value,
        evidence: input.evidence,
        sourceUrl: input.sourceUrl,
        detected: true,
        createdAt: new Date(),
      },
    });
}

/** Contacts with a crawl but no email yet — what a backfill would target. */
export async function contactsMissingEmail(ctx: Ctx, limit = 100) {
  return getDb()
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        isNull(contacts.email),
        sql`${companies.enrichedAt} is not null`,
      ),
    )
    .limit(limit);
}
