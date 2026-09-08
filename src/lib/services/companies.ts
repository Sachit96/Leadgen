import { and, eq, ilike, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { companyKey } from '@/lib/core/phone';
import { notFound } from '@/lib/core/errors';
import type { Ctx } from '@/lib/auth/context';
import type { Company } from '@/lib/db/types';

export type CompanyInput = {
  name: string;
  website?: string | null;
  industry?: string | null;
  subIndustry?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  googleReviews?: number | null;
  googleRating?: number | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  websiteQuality?: string | null;
  adPresence?: boolean | null;
  leadGenerationSignals?: string[];
  bookingSystemDetected?: boolean | null;
  crmDetected?: string | null;
  estimatedCompanySize?: string | null;
  ownerName?: string | null;
  personalizationHooks?: string[];
  researchNotes?: string | null;
};

export async function getCompany(ctx: Ctx, id: string): Promise<Company> {
  const rows = await getDb()
    .select()
    .from(companies)
    .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Company');
  return row;
}

export async function createCompany(ctx: Ctx, input: CompanyInput): Promise<Company> {
  const [row] = await getDb()
    .insert(companies)
    .values({ organizationId: ctx.organizationId, ...normalize(input) })
    .returning();
  return row!;
}

export async function updateCompany(
  ctx: Ctx,
  id: string,
  input: Partial<CompanyInput>,
): Promise<Company> {
  await getCompany(ctx, id);
  const [row] = await getDb()
    .update(companies)
    .set({ ...normalize(input), updatedAt: new Date() })
    .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)))
    .returning();
  return row!;
}

/**
 * Import path: matches an existing company by normalized name (suffixes and
 * punctuation stripped) so "ABC Roofing Inc." and "ABC Roofing" are one row.
 * Only fills blanks — an import never overwrites researched data.
 */
export async function findOrCreateCompany(ctx: Ctx, input: CompanyInput): Promise<Company> {
  const key = companyKey(input.name);
  if (key) {
    const candidates = await getDb()
      .select()
      .from(companies)
      .where(
        and(eq(companies.organizationId, ctx.organizationId), ilike(companies.name, `%${input.name.slice(0, 40)}%`)),
      )
      .limit(25);
    const match = candidates.find((c) => companyKey(c.name) === key);
    if (match) {
      const fill = fillBlanks(match, input);
      if (Object.keys(fill).length > 0) return updateCompany(ctx, match.id, fill);
      return match;
    }
  }
  return createCompany(ctx, input);
}

function fillBlanks(existing: Company, input: CompanyInput): Partial<CompanyInput> {
  const patch: Record<string, unknown> = {};
  const keys: Array<keyof CompanyInput> = [
    'website',
    'industry',
    'subIndustry',
    'city',
    'province',
    'country',
    'googleReviews',
    'googleRating',
    'facebookUrl',
    'instagramUrl',
    'linkedinUrl',
    'ownerName',
    'estimatedCompanySize',
  ];
  for (const key of keys) {
    const incoming = input[key];
    const current = (existing as unknown as Record<string, unknown>)[key];
    if ((current === null || current === undefined) && incoming !== null && incoming !== undefined) {
      patch[key] = incoming;
    }
  }
  return patch as Partial<CompanyInput>;
}

function normalize<T extends Partial<CompanyInput>>(input: T): T {
  return {
    ...input,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.website !== undefined ? { website: normalizeUrl(input.website) } : {}),
  };
}

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Distinct industries in the org — powers the prospects filter dropdown. */
export async function listIndustries(ctx: Ctx): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ industry: companies.industry })
    .from(companies)
    .where(and(eq(companies.organizationId, ctx.organizationId), sql`${companies.industry} is not null`));
  return rows.map((r) => r.industry).filter((i): i is string => Boolean(i)).sort();
}
