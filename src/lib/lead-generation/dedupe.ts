import { and, eq, or } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts, duplicateMatches } from '@/lib/db/schema';
import type { Ctx } from '@/lib/auth/context';
import type { DuplicateReason } from '@/lib/constants/enums';
import { addressSimilarity, nameSimilarity, type NormalizedLead } from './normalize';

/**
 * Deduplication against the existing CRM.
 *
 * Tiers run strongest first and stop at the first hit. Nothing is ever deleted:
 * a match is recorded in `duplicate_matches` with the evidence that produced
 * it, so a wrong call can be seen and undone.
 */
export type DuplicateDecision = {
  isDuplicate: boolean;
  companyId: string | null;
  reason: DuplicateReason | null;
  /** Confidence in the match, 0-1. */
  score: number;
  evidence: Record<string, unknown>;
};

const NOT_DUPLICATE: DuplicateDecision = {
  isDuplicate: false,
  companyId: null,
  reason: null,
  score: 0,
  evidence: {},
};

/** Below this, a name+address match is not treated as the same business. */
const NAME_ADDRESS_THRESHOLD = 0.82;

export async function findDuplicate(ctx: Ctx, lead: NormalizedLead): Promise<DuplicateDecision> {
  const db = getDb();

  // 1. Provider id — the business is definitionally the same record.
  if (lead.externalId) {
    const rows = await db
      .select({ id: companies.id, externalId: companies.externalId })
      .from(companies)
      .where(
        and(eq(companies.organizationId, ctx.organizationId), eq(companies.externalId, lead.externalId)),
      )
      .limit(1);
    if (rows[0]) {
      return {
        isDuplicate: true,
        companyId: rows[0].id,
        reason: 'place_id',
        score: 1,
        evidence: { externalId: lead.externalId },
      };
    }
  }

  // 2. Phone — two businesses sharing a number are the same business, or one
  //    is a franchise using the other's line; either way, do not call twice.
  if (lead.phone) {
    const rows = await db
      .select({ companyId: contacts.companyId, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.phone, lead.phone)))
      .limit(1);
    if (rows[0]?.companyId) {
      return {
        isDuplicate: true,
        companyId: rows[0].companyId,
        reason: 'phone',
        score: 0.97,
        evidence: { phone: lead.phone },
      };
    }
  }

  // 3. Website domain.
  if (lead.websiteDomain) {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.organizationId, ctx.organizationId),
          eq(companies.websiteDomain, lead.websiteDomain),
        ),
      )
      .limit(1);
    if (rows[0]) {
      return {
        isDuplicate: true,
        companyId: rows[0].id,
        reason: 'website_domain',
        score: 0.93,
        evidence: { domain: lead.websiteDomain },
      };
    }
  }

  // 4. Email.
  if (lead.email) {
    const rows = await db
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.email, lead.email)))
      .limit(1);
    if (rows[0]?.companyId) {
      return {
        isDuplicate: true,
        companyId: rows[0].companyId,
        reason: 'email',
        score: 0.9,
        evidence: { email: lead.email },
      };
    }
  }

  // 5. Name + address. Weakest tier, so it needs both to agree. Candidates are
  //    narrowed by name key or city in SQL rather than scanning the table.
  if (lead.nameKey) {
    const candidates = await db
      .select({
        id: companies.id,
        name: companies.name,
        nameKey: companies.nameKey,
        addressLine: companies.addressLine,
        city: companies.city,
      })
      .from(companies)
      .where(
        and(
          eq(companies.organizationId, ctx.organizationId),
          or(
            eq(companies.nameKey, lead.nameKey),
            lead.city ? eq(companies.city, lead.city) : undefined,
          ),
        ),
      )
      .limit(200);

    let best: DuplicateDecision = NOT_DUPLICATE;
    for (const candidate of candidates) {
      const nameScore = nameSimilarity(lead.nameKey, candidate.nameKey);
      if (nameScore < 0.6) continue;

      const addressScore = addressSimilarity(lead.addressLine, candidate.addressLine);
      const sameCity = Boolean(lead.city && candidate.city && lead.city === candidate.city);

      // An exact name key in the same city is enough; otherwise the address has
      // to corroborate it.
      const combined =
        nameScore === 1 && sameCity
          ? 0.88
          : nameScore * 0.6 + addressScore * 0.4;

      if (combined >= NAME_ADDRESS_THRESHOLD && combined > best.score) {
        best = {
          isDuplicate: true,
          companyId: candidate.id,
          reason: 'name_and_address',
          score: Math.round(combined * 100) / 100,
          evidence: {
            nameScore: Math.round(nameScore * 100) / 100,
            addressScore,
            sameCity,
            matchedName: candidate.name,
          },
        };
      }
    }
    if (best.isDuplicate) return best;
  }

  return NOT_DUPLICATE;
}

/** Records the decision. Called only when a duplicate was actually found. */
export async function recordDuplicate(
  ctx: Ctx,
  decision: DuplicateDecision,
  discoveryRecordId: string,
): Promise<void> {
  if (!decision.isDuplicate || !decision.companyId || !decision.reason) return;
  await getDb().insert(duplicateMatches).values({
    organizationId: ctx.organizationId,
    discoveryRecordId,
    matchedCompanyId: decision.companyId,
    reason: decision.reason,
    score: decision.score,
    evidence: decision.evidence,
  });
}
