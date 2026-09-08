import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { notifications } from '@/lib/db/schema';
import type { Ctx } from '@/lib/auth/context';
import type { NotificationType } from '@/lib/db/types';

export type NotifyInput = {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  /** null delivers to everyone in the org. */
  userId?: string | null;
};

export async function notify(ctx: Ctx, input: NotifyInput): Promise<void> {
  await getDb().insert(notifications).values({
    organizationId: ctx.organizationId,
    userId: input.userId ?? null,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
  });
}

export async function listNotifications(ctx: Ctx, limit = 30) {
  return getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.organizationId, ctx.organizationId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function countUnread(ctx: Ctx): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.organizationId, ctx.organizationId), isNull(notifications.readAt)));
  return rows[0]?.count ?? 0;
}

export async function markNotificationRead(ctx: Ctx, id: string): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.organizationId, ctx.organizationId)));
}

export async function markAllNotificationsRead(ctx: Ctx): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.organizationId, ctx.organizationId), isNull(notifications.readAt)));
}
