import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts } from '@/lib/db/schema';
import { notFound } from '@/lib/core/errors';
import type { TemplateVars } from '@/lib/core/template';
import type { Ctx } from '@/lib/auth/context';
import { getOrgConfig } from './settings';

/**
 * Builds the personalization context for a prospect.
 *
 * Two products come out of this: `vars` for template substitution, and `facts`
 * — the verified, sourced statements the AI is permitted to reference. The
 * separation matters: the agent prompt is built only from `facts`, so the model
 * has nothing to draw on except things actually recorded about the company.
 */
export type PersonalizationContext = {
  contactId: string;
  vars: TemplateVars;
  /** Statements known to be true, each traceable to a stored field. */
  facts: string[];
  /** Fields we do not know. Named explicitly so the model cannot invent them. */
  unknowns: string[];
  hook: string | null;
  companyName: string | null;
  city: string | null;
  industry: string | null;
};

const SERVICE_BY_INDUSTRY: Record<string, string> = {
  roofing: 'roof replacements and repairs',
  hvac: 'heating and cooling installs',
  plumbing: 'plumbing jobs',
  landscaping: 'landscaping projects',
  'home renovation': 'renovation projects',
  renovation: 'renovation projects',
  painting: 'painting jobs',
  'auto detailing': 'detailing bookings',
  solar: 'solar installs',
  windows: 'window replacements',
  paving: 'paving jobs',
};

export function serviceFor(industry: string | null | undefined): string {
  if (!industry) return 'jobs';
  const key = industry.toLowerCase().trim();
  for (const [needle, service] of Object.entries(SERVICE_BY_INDUSTRY)) {
    if (key.includes(needle)) return service;
  }
  return 'jobs';
}

/**
 * Picks the strongest available hook. Returns null rather than a generic
 * filler — an empty hook is caught by strict rendering and the send is
 * blocked, which is the correct outcome for an unresearched prospect.
 */
export function chooseHook(company: {
  name?: string | null;
  city?: string | null;
  googleReviews?: number | null;
  personalizationHooks?: unknown;
  researchOutreachAngle?: string | null;
} | null): string | null {
  if (!company) return null;

  const stored = Array.isArray(company.personalizationHooks)
    ? (company.personalizationHooks as string[]).filter((h) => typeof h === 'string' && h.trim())
    : [];
  if (stored.length > 0) return stored[0]!.trim();

  if (company.googleReviews && company.googleReviews >= 25 && company.city) {
    return `You've clearly built a reputation with ${company.city} homeowners`;
  }
  if (company.city) return `You've been serving ${company.city} homeowners for a while`;
  return null;
}

export async function buildPersonalizationContext(
  ctx: Ctx,
  contactId: string,
): Promise<PersonalizationContext> {
  const rows = await getDb()
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Prospect');
  const { contact, company } = row;
  const config = await getOrgConfig(ctx);

  const hook = chooseHook(company);
  const service = serviceFor(company?.industry);
  const firstName = contact.firstName ?? company?.ownerName?.split(' ')[0] ?? null;

  const vars: TemplateVars = {
    first_name: firstName,
    last_name: contact.lastName,
    full_name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null,
    company: company?.name ?? null,
    city: company?.city ?? null,
    province: company?.province ?? null,
    industry: company?.industry ?? null,
    service,
    personalization_hook: hook,
    owner_name: company?.ownerName ?? null,
    reviews: company?.googleReviews ?? null,
    rating: company?.googleRating ?? null,
    website: company?.website ?? null,
    sender_name: config.ai.agentName,
    offer_name: config.offer.productName,
    company_name: config.offer.companyName,
  };

  const facts: string[] = [];
  const unknowns: string[] = [];

  const push = (value: unknown, statement: string, unknownLabel: string) => {
    if (value === null || value === undefined || value === '') unknowns.push(unknownLabel);
    else facts.push(statement);
  };

  push(company?.name, `The business is called ${company?.name}.`, 'company name');
  push(company?.city, `They are based in ${company?.city}${company?.province ? `, ${company.province}` : ''}.`, 'city');
  push(company?.industry, `They work in ${company?.industry}.`, 'industry');
  push(
    company?.googleReviews,
    `They have ${company?.googleReviews} Google reviews${company?.googleRating ? ` averaging ${company.googleRating}` : ''}.`,
    'review count',
  );
  push(company?.ownerName, `The owner is ${company?.ownerName}.`, 'owner name');

  if (company?.crmDetected) facts.push(`They appear to use ${company.crmDetected} as a CRM.`);
  else unknowns.push('CRM in use');

  if (company?.bookingSystemDetected === true) facts.push('They have an online booking system.');
  else if (company?.bookingSystemDetected === false) facts.push('No online booking system was found on their site.');
  else unknowns.push('booking system');

  if (company?.adPresence === true) facts.push('They are currently running paid advertising.');
  else if (company?.adPresence === false) facts.push('No paid advertising was detected.');
  else unknowns.push('advertising activity');

  if (company?.researchSummary) facts.push(`Research summary: ${company.researchSummary}`);
  if (Array.isArray(company?.researchPainPoints)) {
    for (const pain of company.researchPainPoints as string[]) {
      if (typeof pain === 'string' && pain.trim()) facts.push(`Likely pain point: ${pain}`);
    }
  }

  return {
    contactId,
    vars,
    facts,
    unknowns,
    hook,
    companyName: company?.name ?? null,
    city: company?.city ?? null,
    industry: company?.industry ?? null,
  };
}

/** Variables a template may use, for the composer's helper UI. */
export const AVAILABLE_VARIABLES = [
  { key: 'first_name', description: "Prospect's first name, or the owner's first name" },
  { key: 'company', description: 'Company name' },
  { key: 'city', description: 'City' },
  { key: 'province', description: 'Province or state' },
  { key: 'industry', description: 'Industry' },
  { key: 'service', description: 'Their service in plain language (e.g. "roof replacements")' },
  { key: 'personalization_hook', description: 'Researched opening line specific to this business' },
  { key: 'owner_name', description: 'Owner name from research' },
  { key: 'reviews', description: 'Google review count' },
  { key: 'sender_name', description: 'Your agent name from settings' },
  { key: 'offer_name', description: 'Your product name from settings' },
] as const;
