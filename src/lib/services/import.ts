import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts, importBatches } from '@/lib/db/schema';
import { autoMapColumns, parseCsv, splitName } from '@/lib/core/csv';
import { companyKey, normalizeEmail, normalizeName, normalizePhone } from '@/lib/core/phone';
import { invalid } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import { recordActivity } from './activity';
import { normalizeUrl } from './companies';
import { rescoreProspect } from './contacts';
import type { Ctx } from '@/lib/auth/context';

export type ImportRow = {
  rowNumber: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  phoneRaw: string | null;
  email: string | null;
  title: string | null;
  companyName: string | null;
  website: string | null;
  city: string | null;
  province: string | null;
  industry: string | null;
  googleReviews: number | null;
  googleRating: number | null;
  /** Why this row cannot be imported, if it cannot. */
  error: string | null;
  duplicateOf: string | null;
};

export type ImportPreview = {
  headers: string[];
  mapping: Record<string, number>;
  rows: ImportRow[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  errorRows: number;
};

const MAX_PREVIEW_ROWS = 2000;

/**
 * Parses and validates a CSV without writing anything.
 *
 * The operator sees exactly what will happen — including which rows are
 * duplicates of existing prospects and which are unusable — before any row is
 * committed. An import never silently corrupts the list.
 */
export async function previewImport(
  ctx: Ctx,
  csv: string,
  overrides?: Record<string, number>,
): Promise<ImportPreview> {
  assertCan(ctx.role, 'prospect:import');

  const table = parseCsv(csv);
  if (table.length < 2) throw invalid('That file has no data rows');

  const headers = (table[0] ?? []).map((h) => h.trim());
  const mapping = { ...autoMapColumns(headers), ...(overrides ?? {}) };

  if (mapping.phone === undefined) {
    throw invalid('No phone column was found. Map one before importing.');
  }

  const dataRows = table.slice(1, MAX_PREVIEW_ROWS + 1);
  const rows: ImportRow[] = [];
  const seenPhones = new Set<string>();

  for (const [index, raw] of dataRows.entries()) {
    const get = (field: string): string | null => {
      const column = mapping[field];
      if (column === undefined) return null;
      const value = raw[column];
      return value === undefined || value.trim() === '' ? null : value.trim();
    };

    const phoneRaw = get('phone');
    const normalized = normalizePhone(phoneRaw);

    let firstName = normalizeName(get('firstName'));
    let lastName = normalizeName(get('lastName'));
    const fullName = get('fullName');
    if (!firstName && fullName) {
      const split = splitName(fullName);
      firstName = normalizeName(split.firstName);
      lastName = lastName ?? normalizeName(split.lastName);
    }

    let error: string | null = null;
    if (!phoneRaw) error = 'Missing phone number';
    else if (!normalized.valid) error = `Invalid phone number (${normalized.reason ?? 'unrecognized'})`;
    else if (seenPhones.has(normalized.e164!)) error = 'Duplicate phone number within this file';

    if (normalized.e164 && !error) seenPhones.add(normalized.e164);

    rows.push({
      rowNumber: index + 2,
      firstName,
      lastName,
      phone: normalized.e164,
      phoneRaw,
      email: normalizeEmail(get('email')),
      title: get('title'),
      companyName: get('companyName'),
      website: normalizeUrl(get('website')),
      city: get('city'),
      province: get('province'),
      industry: get('industry'),
      googleReviews: toInt(get('googleReviews')),
      googleRating: toFloat(get('googleRating')),
      error,
      duplicateOf: null,
    });
  }

  // One query to flag rows that already exist in the CRM.
  const phones = rows.map((r) => r.phone).filter((p): p is string => Boolean(p));
  if (phones.length > 0) {
    const existing = await getDb()
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.phone, phones)));
    const byPhone = new Map(existing.map((e) => [e.phone, e.id]));
    for (const row of rows) {
      if (row.phone && byPhone.has(row.phone)) row.duplicateOf = byPhone.get(row.phone)!;
    }
  }

  return {
    headers,
    mapping,
    rows,
    totalRows: dataRows.length,
    validRows: rows.filter((r) => !r.error && !r.duplicateOf).length,
    duplicateRows: rows.filter((r) => r.duplicateOf).length,
    errorRows: rows.filter((r) => r.error).length,
  };
}

export type ImportResult = {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  contactIds: string[];
};

export type CommitImportOptions = {
  filename: string;
  /** Fill blank fields on prospects that already exist. */
  updateExisting?: boolean;
  source?: string;
  campaignId?: string;
};

export async function commitImport(
  ctx: Ctx,
  csv: string,
  options: CommitImportOptions,
  overrides?: Record<string, number>,
): Promise<ImportResult> {
  assertCan(ctx.role, 'prospect:import');
  const preview = await previewImport(ctx, csv, overrides);
  const db = getDb();

  const result: ImportResult = {
    batchId: '',
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    contactIds: [],
  };

  for (const row of preview.rows) {
    if (row.error || !row.phone) {
      result.skipped += 1;
      if (row.error) result.errors.push({ row: row.rowNumber, message: row.error });
      continue;
    }

    try {
      if (row.duplicateOf) {
        if (!options.updateExisting) {
          result.skipped += 1;
          continue;
        }
        await fillBlanks(ctx, row.duplicateOf, row);
        result.updated += 1;
        result.contactIds.push(row.duplicateOf);
        continue;
      }

      const companyId = row.companyName ? await upsertCompany(ctx, row) : null;

      const [created] = await db
        .insert(contacts)
        .values({
          organizationId: ctx.organizationId,
          companyId,
          firstName: row.firstName,
          lastName: row.lastName,
          phone: row.phone,
          phoneRaw: row.phoneRaw,
          email: row.email,
          title: row.title,
          status: 'NEW',
          source: options.source ?? 'csv_import',
          lastActivityAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      if (!created) {
        result.skipped += 1;
        continue;
      }

      result.created += 1;
      result.contactIds.push(created.id);

      await recordActivity(ctx, {
        type: 'prospect_imported',
        title: `Imported from ${options.filename}`,
        contactId: created.id,
        metadata: { row: row.rowNumber },
      });

      if (companyId) await rescoreProspect(ctx, created.id);
    } catch (error) {
      result.skipped += 1;
      result.errors.push({
        row: row.rowNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const [batch] = await db
    .insert(importBatches)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.user?.userId ?? null,
      filename: options.filename,
      totalRows: preview.totalRows,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors.slice(0, 200),
    })
    .returning();

  result.batchId = batch!.id;
  return result;
}

async function upsertCompany(ctx: Ctx, row: ImportRow): Promise<string | null> {
  if (!row.companyName) return null;
  const db = getDb();
  const key = companyKey(row.companyName);

  if (key) {
    const candidates = await db
      .select()
      .from(companies)
      .where(eq(companies.organizationId, ctx.organizationId))
      .limit(500);
    const match = candidates.find((c) => companyKey(c.name) === key);
    if (match) return match.id;
  }

  const [created] = await db
    .insert(companies)
    .values({
      organizationId: ctx.organizationId,
      name: row.companyName,
      website: row.website,
      city: row.city,
      province: row.province,
      industry: row.industry,
      googleReviews: row.googleReviews,
      googleRating: row.googleRating,
    })
    .returning();
  return created?.id ?? null;
}

/** Import never overwrites a value that is already present. */
async function fillBlanks(ctx: Ctx, contactId: string, row: ImportRow): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  const existing = rows[0];
  if (!existing) return;

  const patch: Record<string, unknown> = {};
  if (!existing.firstName && row.firstName) patch.firstName = row.firstName;
  if (!existing.lastName && row.lastName) patch.lastName = row.lastName;
  if (!existing.email && row.email) patch.email = row.email;
  if (!existing.title && row.title) patch.title = row.title;

  if (!existing.companyId && row.companyName) {
    patch.companyId = await upsertCompany(ctx, row);
  }

  if (Object.keys(patch).length === 0) return;
  patch.updatedAt = new Date();
  await db.update(contacts).set(patch).where(eq(contacts.id, contactId));
}

function toInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFloat(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
