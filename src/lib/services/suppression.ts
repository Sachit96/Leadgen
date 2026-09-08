import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { campaignMemberships, contacts, conversations, suppressionEntries } from '@/lib/db/schema';
import { normalizePhone } from '@/lib/core/phone';
import { invalid } from '@/lib/core/errors';
import { recordActivity } from './activity';
import type { Ctx } from '@/lib/auth/context';
import type { SuppressionReason } from '@/lib/db/types';

/**
 * The suppression list is the hard stop for automated outreach.
 *
 * Everything that can queue an outbound message consults `isSuppressed` first,
 * and `suppress` additionally tears down the in-flight automation (campaign
 * memberships, AI replies) rather than relying on the next check to catch it.
 */
export async function isSuppressed(ctx: Ctx, phone: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: suppressionEntries.id })
    .from(suppressionEntries)
    .where(
      and(
        eq(suppressionEntries.organizationId, ctx.organizationId),
        eq(suppressionEntries.phone, phone),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function suppressedSet(ctx: Ctx, phones: string[]): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const rows = await getDb()
    .select({ phone: suppressionEntries.phone })
    .from(suppressionEntries)
    .where(
      and(
        eq(suppressionEntries.organizationId, ctx.organizationId),
        inArray(suppressionEntries.phone, phones),
      ),
    );
  return new Set(rows.map((r) => r.phone));
}

export type SuppressInput = {
  phone: string;
  reason: SuppressionReason;
  note?: string | null;
  contactId?: string | null;
};

export async function suppress(ctx: Ctx, input: SuppressInput): Promise<void> {
  const normalized = normalizePhone(input.phone);
  const phone = normalized.e164 ?? input.phone;
  const db = getDb();

  await db
    .insert(suppressionEntries)
    .values({
      organizationId: ctx.organizationId,
      phone,
      reason: input.reason,
      note: input.note ?? null,
      createdByUserId: ctx.user?.userId ?? null,
    })
    .onConflictDoNothing();

  // Resolve the contact so the stop cascades to their live automation.
  const contactRows = input.contactId
    ? await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, ctx.organizationId)))
        .limit(1)
    : await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.phone, phone)))
        .limit(1);

  const contactId = contactRows[0]?.id;
  if (!contactId) return;

  await db
    .update(contacts)
    .set({ status: 'DO_NOT_CONTACT', nextActionAt: null, nextAction: null, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));

  await db
    .update(campaignMemberships)
    .set({ status: 'STOPPED', nextStepAt: null, stoppedReason: `suppressed:${input.reason}` })
    .where(
      and(
        eq(campaignMemberships.organizationId, ctx.organizationId),
        eq(campaignMemberships.contactId, contactId),
        inArray(campaignMemberships.status, ['PENDING', 'ACTIVE', 'PAUSED']),
      ),
    );

  await db
    .update(conversations)
    .set({
      state: 'DO_NOT_CONTACT',
      aiEnabled: false,
      aiPausedReason: `suppressed:${input.reason}`,
      nextFollowUpAt: null,
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.contactId, contactId),
      ),
    );

  await recordActivity(ctx, {
    type: 'suppressed',
    title: `Added to do-not-contact (${input.reason})`,
    body: input.note ?? null,
    contactId,
    metadata: { reason: input.reason, phone },
  });
}

export async function unsuppress(ctx: Ctx, phone: string): Promise<void> {
  const normalized = normalizePhone(phone);
  const target = normalized.e164 ?? phone;
  const deleted = await getDb()
    .delete(suppressionEntries)
    .where(
      and(eq(suppressionEntries.organizationId, ctx.organizationId), eq(suppressionEntries.phone, target)),
    )
    .returning({ id: suppressionEntries.id });
  if (deleted.length === 0) throw invalid('That number is not on the suppression list');
}

export async function listSuppression(ctx: Ctx, limit = 200) {
  return getDb()
    .select()
    .from(suppressionEntries)
    .where(eq(suppressionEntries.organizationId, ctx.organizationId))
    .orderBy(desc(suppressionEntries.createdAt))
    .limit(limit);
}
