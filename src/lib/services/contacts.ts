import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { campaignMemberships, campaigns, companies, contacts, conversations, users } from '@/lib/db/schema';
import { normalizeEmail, normalizeName, normalizePhone } from '@/lib/core/phone';
import { scoreProspect, type ScoringInput } from '@/lib/core/scoring';
import { conflict, invalid, notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import { recordActivity } from './activity';
import { getOrgConfig } from './settings';
import { findOrCreateCompany, type CompanyInput } from './companies';
import type { Ctx } from '@/lib/auth/context';
import type { Contact, ProspectStatus } from '@/lib/db/types';

export type ProspectRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  email: string | null;
  status: ProspectStatus;
  score: number | null;
  scoreBucket: string | null;
  lastActivityAt: Date | null;
  nextActionAt: Date | null;
  nextAction: string | null;
  createdAt: Date;
  companyId: string | null;
  companyName: string | null;
  companyCity: string | null;
  companyProvince: string | null;
  companyIndustry: string | null;
  companyWebsite: string | null;
  companyReviews: number | null;
  companyRating: number | null;
  companyOwner: string | null;
  ownerName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  conversationId: string | null;
};

export type ProspectFilters = {
  search?: string;
  status?: ProspectStatus[];
  bucket?: string[];
  industry?: string[];
  city?: string[];
  campaignId?: string | 'none';
  ownerUserId?: string | 'unassigned';
  minScore?: number;
  maxScore?: number;
  createdAfter?: Date;
  createdBefore?: Date;
};

export type ProspectSort =
  | 'created_desc'
  | 'created_asc'
  | 'score_desc'
  | 'score_asc'
  | 'activity_desc'
  | 'next_action_asc'
  | 'company_asc';

const SORTS: Record<ProspectSort, SQL[]> = {
  created_desc: [desc(contacts.createdAt)],
  created_asc: [asc(contacts.createdAt)],
  score_desc: [sql`${contacts.score} desc nulls last`, desc(contacts.createdAt)],
  score_asc: [sql`${contacts.score} asc nulls last`],
  activity_desc: [sql`${contacts.lastActivityAt} desc nulls last`],
  next_action_asc: [sql`${contacts.nextActionAt} asc nulls last`],
  company_asc: [sql`${companies.name} asc nulls last`],
};

function buildFilters(ctx: Ctx, filters: ProspectFilters): SQL[] {
  const clauses: SQL[] = [eq(contacts.organizationId, ctx.organizationId)];

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    const digits = filters.search.replace(/\D/g, '');
    const searchClauses = [
      ilike(contacts.firstName, term),
      ilike(contacts.lastName, term),
      ilike(contacts.email, term),
      ilike(companies.name, term),
      ilike(companies.city, term),
    ];
    if (digits.length >= 3) searchClauses.push(ilike(contacts.phone, `%${digits}%`));
    const combined = or(...searchClauses);
    if (combined) clauses.push(combined);
  }

  if (filters.status?.length) clauses.push(inArray(contacts.status, filters.status));
  if (filters.bucket?.length) clauses.push(inArray(contacts.scoreBucket, filters.bucket));
  if (filters.industry?.length) clauses.push(inArray(companies.industry, filters.industry));
  if (filters.city?.length) clauses.push(inArray(companies.city, filters.city));
  if (filters.minScore !== undefined) clauses.push(gte(contacts.score, filters.minScore));
  if (filters.maxScore !== undefined) clauses.push(lte(contacts.score, filters.maxScore));
  if (filters.createdAfter) clauses.push(gte(contacts.createdAt, filters.createdAfter));
  if (filters.createdBefore) clauses.push(lte(contacts.createdAt, filters.createdBefore));

  if (filters.ownerUserId === 'unassigned') clauses.push(isNull(contacts.ownerUserId));
  else if (filters.ownerUserId) clauses.push(eq(contacts.ownerUserId, filters.ownerUserId));

  if (filters.campaignId === 'none') {
    clauses.push(
      sql`not exists (select 1 from ${campaignMemberships} cm where cm.contact_id = ${contacts.id} and cm.status <> 'STOPPED')`,
    );
  } else if (filters.campaignId) {
    clauses.push(
      sql`exists (select 1 from ${campaignMemberships} cm where cm.contact_id = ${contacts.id} and cm.campaign_id = ${filters.campaignId})`,
    );
  }

  return clauses;
}

/**
 * Server-side paginated prospect list. The browser never receives more than one
 * page, and every filter is applied in SQL against an index.
 */
export async function listProspects(
  ctx: Ctx,
  options: {
    filters?: ProspectFilters;
    sort?: ProspectSort;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ rows: ProspectRow[]; total: number; page: number; pageSize: number; pageCount: number }> {
  const filters = options.filters ?? {};
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, options.pageSize ?? 50));
  const clauses = buildFilters(ctx, filters);
  const db = getDb();

  const base = db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      email: contacts.email,
      status: contacts.status,
      score: contacts.score,
      scoreBucket: contacts.scoreBucket,
      lastActivityAt: contacts.lastActivityAt,
      nextActionAt: contacts.nextActionAt,
      nextAction: contacts.nextAction,
      createdAt: contacts.createdAt,
      companyId: companies.id,
      companyName: companies.name,
      companyCity: companies.city,
      companyProvince: companies.province,
      companyIndustry: companies.industry,
      companyWebsite: companies.website,
      companyReviews: companies.googleReviews,
      companyRating: companies.googleRating,
      companyOwner: companies.ownerName,
      ownerName: users.name,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      conversationId: conversations.id,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(users, eq(users.id, contacts.ownerUserId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .leftJoin(campaigns, eq(campaigns.id, conversations.campaignId))
    .where(and(...clauses));

  const rows = await base
    .orderBy(...(SORTS[options.sort ?? 'created_desc'] ?? SORTS.created_desc))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(...clauses));

  const total = countRows[0]?.count ?? 0;
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Every id matching the filters — used by "select all matching" bulk actions. */
export async function listProspectIds(ctx: Ctx, filters: ProspectFilters, limit = 10_000): Promise<string[]> {
  const rows = await getDb()
    .select({ id: contacts.id })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(...buildFilters(ctx, filters)))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function getProspect(ctx: Ctx, id: string) {
  const rows = await getDb()
    .select({
      contact: contacts,
      company: companies,
      owner: { id: users.id, name: users.name, email: users.email },
      conversation: conversations,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(users, eq(users.id, contacts.ownerUserId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Prospect');
  return row;
}

export async function findByPhone(ctx: Ctx, phone: string): Promise<Contact | null> {
  const normalized = normalizePhone(phone);
  const target = normalized.e164 ?? phone;
  const rows = await getDb()
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.phone, target)))
    .limit(1);
  return rows[0] ?? null;
}

export type ProspectInput = {
  firstName?: string | null;
  lastName?: string | null;
  phone: string;
  email?: string | null;
  title?: string | null;
  timezone?: string | null;
  status?: ProspectStatus;
  source?: string | null;
  ownerUserId?: string | null;
  companyId?: string | null;
  company?: CompanyInput | null;
  customFields?: Record<string, unknown>;
};

export async function createProspect(ctx: Ctx, input: ProspectInput): Promise<Contact> {
  assertCan(ctx.role, 'prospect:write');

  const normalized = normalizePhone(input.phone);
  if (!normalized.valid || !normalized.e164) {
    throw invalid(`"${input.phone}" is not a valid phone number (${normalized.reason ?? 'unknown'})`);
  }

  const existing = await findByPhone(ctx, normalized.e164);
  if (existing) throw conflict('A prospect with that phone number already exists');

  let companyId = input.companyId ?? null;
  if (!companyId && input.company?.name) {
    companyId = (await findOrCreateCompany(ctx, input.company)).id;
  }

  const [row] = await getDb()
    .insert(contacts)
    .values({
      organizationId: ctx.organizationId,
      companyId,
      firstName: normalizeName(input.firstName),
      lastName: normalizeName(input.lastName),
      phone: normalized.e164,
      phoneRaw: input.phone,
      email: normalizeEmail(input.email),
      title: input.title ?? null,
      timezone: input.timezone ?? null,
      status: input.status ?? 'NEW',
      source: input.source ?? 'manual',
      ownerUserId: input.ownerUserId ?? null,
      customFields: input.customFields ?? {},
      lastActivityAt: new Date(),
    })
    .returning();

  await recordActivity(ctx, {
    type: 'prospect_created',
    title: 'Prospect created',
    contactId: row!.id,
    metadata: { source: input.source ?? 'manual' },
  });

  if (companyId) await rescoreProspect(ctx, row!.id);
  return row!;
}

export async function updateProspect(
  ctx: Ctx,
  id: string,
  input: Partial<ProspectInput>,
): Promise<Contact> {
  assertCan(ctx.role, 'prospect:write');
  const { contact } = await getProspect(ctx, id);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.firstName !== undefined) patch.firstName = normalizeName(input.firstName);
  if (input.lastName !== undefined) patch.lastName = normalizeName(input.lastName);
  if (input.email !== undefined) patch.email = normalizeEmail(input.email);
  if (input.title !== undefined) patch.title = input.title;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
  if (input.companyId !== undefined) patch.companyId = input.companyId;
  if (input.customFields !== undefined) patch.customFields = input.customFields;
  if (input.source !== undefined) patch.source = input.source;

  if (input.status !== undefined && input.status !== contact.status) {
    if (contact.status === 'DO_NOT_CONTACT' && input.status !== 'DO_NOT_CONTACT') {
      throw invalid('Remove the number from the suppression list before changing this status');
    }
    patch.status = input.status;
  }

  if (input.phone !== undefined) {
    const normalized = normalizePhone(input.phone);
    if (!normalized.valid || !normalized.e164) throw invalid('That phone number is not valid');
    if (normalized.e164 !== contact.phone) {
      const clash = await findByPhone(ctx, normalized.e164);
      if (clash && clash.id !== id) throw conflict('Another prospect already uses that phone number');
      patch.phone = normalized.e164;
      patch.phoneRaw = input.phone;
    }
  }

  const [row] = await getDb()
    .update(contacts)
    .set(patch)
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, ctx.organizationId)))
    .returning();

  await recordActivity(ctx, {
    type: 'prospect_updated',
    title: 'Prospect updated',
    contactId: id,
    metadata: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') },
  });

  if (input.status !== undefined && input.status !== contact.status) {
    await recordActivity(ctx, {
      type: 'state_changed',
      title: `Status ${contact.status} → ${input.status}`,
      contactId: id,
      metadata: { from: contact.status, to: input.status },
    });
  }

  return row!;
}

export async function setProspectStatus(ctx: Ctx, id: string, status: ProspectStatus): Promise<void> {
  await updateProspect(ctx, id, { status });
}

/**
 * Advances status only when the new value is further along the funnel, so a
 * late delivery receipt can never pull a QUALIFIED prospect back to CONTACTED.
 */
const STATUS_RANK: Record<ProspectStatus, number> = {
  NEW: 0,
  RESEARCHING: 1,
  READY: 2,
  QUEUED: 3,
  CONTACTED: 4,
  REPLIED: 5,
  QUALIFIED: 6,
  APPOINTMENT: 7,
  OPPORTUNITY: 8,
  WON: 9,
  LOST: 9,
  DO_NOT_CONTACT: 10,
};

export async function advanceProspectStatus(
  ctx: Ctx,
  id: string,
  status: ProspectStatus,
): Promise<void> {
  const rows = await getDb()
    .select({ status: contacts.status })
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);
  const current = rows[0]?.status;
  if (!current) return;
  if (current === 'DO_NOT_CONTACT') return;
  if (STATUS_RANK[status] <= STATUS_RANK[current]) return;

  await getDb()
    .update(contacts)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, ctx.organizationId)));

  await recordActivity(ctx, {
    type: 'state_changed',
    title: `Status ${current} → ${status}`,
    contactId: id,
    metadata: { from: current, to: status, automatic: true },
  });
}

export async function rescoreProspect(ctx: Ctx, contactId: string) {
  const { contact, company } = await getProspect(ctx, contactId);
  const config = (await getOrgConfig(ctx)).scoring;

  const input: ScoringInput = {
    industry: company?.industry ?? null,
    googleReviews: company?.googleReviews ?? null,
    googleRating: company?.googleRating ?? null,
    adPresence: company?.adPresence ?? null,
    crmDetected: company?.crmDetected ?? null,
    bookingSystemDetected: company?.bookingSystemDetected ?? null,
    ownerName: company?.ownerName ?? null,
    websiteQuality: company?.websiteQuality ?? null,
    website: company?.website ?? null,
    estimatedCompanySize: company?.estimatedCompanySize ?? null,
    leadGenerationSignals: Array.isArray(company?.leadGenerationSignals)
      ? (company.leadGenerationSignals as string[])
      : [],
  };

  const result = scoreProspect(input, config);
  const changed = contact.score !== result.score;

  await getDb()
    .update(contacts)
    .set({
      score: result.score,
      scoreBucket: result.bucket,
      scoreBreakdown: result.breakdown,
      scoredAt: new Date(),
      scoringVersion: result.version,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));

  if (changed) {
    await recordActivity(ctx, {
      type: 'score_changed',
      title: `On Radar score: ${result.score} (${result.bucket})`,
      contactId,
      metadata: { from: contact.score, to: result.score, bucket: result.bucket },
    });
  }

  return result;
}

export async function rescoreMany(ctx: Ctx, contactIds: string[]): Promise<number> {
  assertCan(ctx.role, 'prospect:write');
  let count = 0;
  for (const id of contactIds) {
    await rescoreProspect(ctx, id);
    count += 1;
  }
  return count;
}

export async function assignOwner(ctx: Ctx, contactIds: string[], ownerUserId: string | null) {
  assertCan(ctx.role, 'prospect:write');
  if (contactIds.length === 0) return 0;
  const updated = await getDb()
    .update(contacts)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, contactIds)))
    .returning({ id: contacts.id });
  return updated.length;
}

export async function deleteProspects(ctx: Ctx, contactIds: string[]): Promise<number> {
  assertCan(ctx.role, 'prospect:write');
  if (contactIds.length === 0) return 0;
  const deleted = await getDb()
    .delete(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, contactIds)))
    .returning({ id: contacts.id });
  return deleted.length;
}

export function displayName(contact: {
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  return name || 'Unknown';
}

/** Distinct cities present in the org — powers the prospects filter dropdown. */
export async function listCities(ctx: Ctx): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ city: companies.city })
    .from(companies)
    .where(and(eq(companies.organizationId, ctx.organizationId), sql`${companies.city} is not null`));
  return rows.map((r) => r.city).filter((c): c is string => Boolean(c)).sort();
}

export async function countByStatus(ctx: Ctx): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ status: contacts.status, count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(eq(contacts.organizationId, ctx.organizationId))
    .groupBy(contacts.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
