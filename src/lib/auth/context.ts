import { cookies } from 'next/headers';
import { AppError } from '@/lib/core/errors';
import { assertCan, type Permission } from './rbac';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './session';
import type { UserRole } from '@/lib/db/types';

/**
 * The tenant context every service function requires as its first argument.
 *
 * Making this a required parameter (rather than an ambient lookup) is what
 * keeps tenant scoping honest: a service query cannot be written without an
 * organization id in hand.
 */
export type Ctx = {
  organizationId: string;
  userId: string;
  role: UserRole;
  timezone: string;
  /** Present for user-initiated work; absent for background jobs. */
  user?: SessionUser;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  // Covers a preview session that outlived its in-memory database — a dev
  // server restart wipes the data but leaves the cookie in the browser.
  const { ensurePreviewData } = await import('@/lib/preview/data');
  await ensurePreviewData();

  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/** Throws UNAUTHENTICATED when there is no valid session. */
export async function requireCtx(permission?: Permission): Promise<Ctx> {
  const user = await getSessionUser();
  if (!user) throw new AppError('UNAUTHENTICATED', 'You must be signed in');
  if (permission) assertCan(user.role, permission);
  return {
    organizationId: user.organizationId,
    userId: user.userId,
    role: user.role,
    timezone: user.organizationTimezone,
    user,
  };
}

/**
 * Context for background work (worker, webhooks, cron). Carries OWNER rights
 * because it acts on behalf of the system, and is never derived from a request
 * body — the organization is always resolved from a trusted server-side lookup.
 */
export function systemCtx(organizationId: string, timezone = 'America/Toronto'): Ctx {
  return {
    organizationId,
    userId: SYSTEM_USER_ID,
    role: 'OWNER',
    timezone,
  };
}

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export function isSystem(ctx: Ctx): boolean {
  return ctx.userId === SYSTEM_USER_ID;
}

/** `actorUserId` for activity rows — null when the system acted. */
export function actorId(ctx: Ctx): string | null {
  return isSystem(ctx) ? null : ctx.userId;
}
