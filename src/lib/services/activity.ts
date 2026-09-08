import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { getDb, type Db } from '@/lib/db';
import { activities, auditLogs, contacts } from '@/lib/db/schema';
import { actorId, isSystem, type Ctx } from '@/lib/auth/context';
import type { ActivityType } from '@/lib/db/types';

/**
 * Activity is the prospect's immutable history. Nothing in the app updates or
 * deletes these rows; corrections are recorded as new events.
 */
export type RecordActivityInput = {
  type: ActivityType;
  title: string;
  body?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  campaignId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordActivity(
  ctx: Ctx,
  input: RecordActivityInput,
  tx?: Db,
): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(activities).values({
    organizationId: ctx.organizationId,
    contactId: input.contactId ?? null,
    conversationId: input.conversationId ?? null,
    campaignId: input.campaignId ?? null,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    actorUserId: actorId(ctx),
    actorKind: isSystem(ctx) ? 'system' : 'user',
    metadata: input.metadata ?? {},
  });

  if (input.contactId) {
    await db
      .update(contacts)
      .set({ lastActivityAt: new Date() })
      .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, ctx.organizationId)));
  }
}

export async function listActivityForContact(ctx: Ctx, contactId: string, limit = 100) {
  return getDb()
    .select()
    .from(activities)
    .where(and(eq(activities.organizationId, ctx.organizationId), eq(activities.contactId, contactId)))
    .orderBy(desc(activities.createdAt))
    .limit(limit);
}

export async function listRecentActivity(ctx: Ctx, limit = 50, before?: Date) {
  const clauses = [eq(activities.organizationId, ctx.organizationId)];
  if (before) clauses.push(lt(activities.createdAt, before));
  return getDb()
    .select()
    .from(activities)
    .where(and(...clauses))
    .orderBy(desc(activities.createdAt))
    .limit(limit);
}

/**
 * Cursor feed backing the SSE stream. Returns rows strictly newer than the
 * cursor, oldest first, so a client can advance its cursor monotonically.
 */
export async function activitySince(ctx: Ctx, since: Date, limit = 100) {
  return getDb()
    .select({
      id: activities.id,
      type: activities.type,
      title: activities.title,
      contactId: activities.contactId,
      conversationId: activities.conversationId,
      createdAt: activities.createdAt,
    })
    .from(activities)
    .where(
      and(eq(activities.organizationId, ctx.organizationId), gt(activities.createdAt, since)),
    )
    .orderBy(activities.createdAt)
    .limit(limit);
}

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
};

export async function recordAudit(ctx: Ctx, input: AuditInput): Promise<void> {
  await getDb().insert(auditLogs).values({
    organizationId: ctx.organizationId,
    userId: actorId(ctx),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
  });
}
