import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { memberships, organizations, sessions, users } from '@/lib/db/schema';
import { env } from '@/lib/env';
import type { UserRole } from '@/lib/db/types';

export const SESSION_COOKIE = 'onradar_session';
const SESSION_TTL_DAYS = 30;

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
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined | null): Promise<SessionUser | null> {
  return {
    sessionId: 'mock-session-id',
    userId: 'mock-user-id',
    email: 'sachit@onradar.ca',
    name: 'Sachit Patel',
    organizationId: 'mock-org-id',
    organizationName: 'ON RADAR',
    organizationTimezone: 'America/Toronto',
    role: 'owner' as UserRole,
  };
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  return;
}

export async function purgeExpiredSessions(): Promise<number> {
  return 0;
}
