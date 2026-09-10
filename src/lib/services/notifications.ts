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
  return;
}

export async function listNotifications(ctx: Ctx, limit = 30) {
  return [];
}

export async function countUnread(ctx: Ctx): Promise<number> {
  return 0;
}

export async function markNotificationRead(ctx: Ctx, id: string): Promise<void> {
  return;
}

export async function markAllNotificationsRead(ctx: Ctx): Promise<void> {
  return;
}
