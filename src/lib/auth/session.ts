import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { memberships, organizations, sessions, users } from '@/lib/db/schema';
import { env } from '@/lib/env';
import type { UserRole } from '@/lib/db/types';

export const SESSION_COOKIE = 'onradar_session';
const SESSION_TTL_DAYS = 30;

/**
 * Session tokens are random 32-byte values. Only an HMAC of the token is
 * stored, so a database leak does not hand out live sessions.
 */
function hashToken(token: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(token).digest('hex');
}

export type SessionUser = {
  userId: string;
  organizationId: string;
  organizationName: string;
  organizationTimezone: string;
  email: string;
  name: string;
  role: UserRole;
  sessionId: string;
};

export async function createSession(userId: string, organizationId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await getDb().insert(sessions).values({
    userId,
    organizationId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;

  const candidate = hashToken(token);
  const rows = await getDb()
    .select({
      sessionId: sessions.id,
      tokenHash: sessions.tokenHash,
      userId: users.id,
      email: users.email,
      name: users.name,
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationTimezone: organizations.timezone,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, sessions.userId), eq(memberships.organizationId, sessions.organizationId)),
    )
    .where(and(eq(sessions.tokenHash, candidate), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Constant-time confirmation, so a partial-index timing signal cannot be used
  // to probe for valid tokens.
  const a = Buffer.from(row.tokenHash);
  const b = Buffer.from(candidate);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationTimezone: row.organizationTimezone,
    role: row.role,
  };
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
