'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { memberships, organizations, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession, SESSION_COOKIE } from '@/lib/auth/session';
import { getSessionUser } from '@/lib/auth/context';
import { seedOrganizationDefaults } from '@/lib/seed/defaults';
import { env } from '@/lib/env';

export type FormState = { error?: string; ok?: boolean };

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

const signupSchema = z.object({
  name: z.string().min(1, 'Enter your name'),
  organizationName: z.string().min(1, 'Enter your company name'),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters'),
});

async function setSessionCookie(userId: string, organizationId: string): Promise<void> {
  const { token, expiresAt } = await createSession(userId, organizationId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check your details' };
  }

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      organizationId: memberships.organizationId,
    })
    .from(users)
    .leftJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(users.email, parsed.data.email.toLowerCase()))
    .limit(1);

  const row = rows[0];
  // Same message and comparable work either way, so the response does not
  // reveal whether an account exists.
  const valid = row ? await verifyPassword(parsed.data.password, row.passwordHash) : false;
  if (!row || !valid || !row.organizationId) {
    return { error: 'Email or password is incorrect' };
  }

  await setSessionCookie(row.id, row.organizationId);
  redirect('/');
}

/**
 * First-run signup. Only permitted while the instance has no organization —
 * after that, accounts are created by an owner from Settings.
 */
export async function signup(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    name: formData.get('name'),
    organizationName: formData.get('organizationName'),
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check your details' };
  }

  const db = getDb();
  const existing = await db.select({ count: sql<number>`count(*)::int` }).from(organizations);
  if ((existing[0]?.count ?? 0) > 0) {
    return { error: 'This instance is already set up. Ask an owner to invite you.' };
  }

  const email = parsed.data.email.toLowerCase();
  const taken = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (taken.length > 0) return { error: 'That email is already registered' };

  const [organization] = await db
    .insert(organizations)
    .values({
      name: parsed.data.organizationName,
      slug: slugify(parsed.data.organizationName),
    })
    .returning();

  const [user] = await db
    .insert(users)
    .values({
      email,
      name: parsed.data.name,
      passwordHash: await hashPassword(parsed.data.password),
    })
    .returning();

  await db
    .insert(memberships)
    .values({ organizationId: organization!.id, userId: user!.id, role: 'OWNER' });

  await seedOrganizationDefaults({
    organizationId: organization!.id,
    userId: user!.id,
    role: 'OWNER',
    timezone: organization!.timezone,
  });

  await setSessionCookie(user!.id, organization!.id);
  redirect('/');
}

export async function logout(): Promise<void> {
  const store = await cookies();
  await destroySession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  redirect('/login');
}

/** Owners and admins can add teammates from Settings. */
export async function inviteUser(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getSessionUser();
  if (!user || (user.role !== 'OWNER' && user.role !== 'ADMIN')) {
    return { error: 'Only owners and admins can add users' };
  }

  const parsed = z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(8, 'Use at least 8 characters'),
      role: z.enum(['ADMIN', 'SALES_REP', 'VIEWER']),
    })
    .safeParse({
      name: formData.get('name'),
      email: formData.get('email'),
      password: formData.get('password'),
      role: formData.get('role'),
    });

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check your details' };

  const db = getDb();
  const email = parsed.data.email.toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  let userId = existing[0]?.id;
  if (!userId) {
    const [created] = await db
      .insert(users)
      .values({
        email,
        name: parsed.data.name,
        passwordHash: await hashPassword(parsed.data.password),
      })
      .returning();
    userId = created!.id;
  }

  const alreadyMember = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.userId, userId), eq(memberships.organizationId, user.organizationId)),
    )
    .limit(1);
  if (alreadyMember.length > 0) return { error: 'That person is already on the team' };

  await db
    .insert(memberships)
    .values({ organizationId: user.organizationId, userId, role: parsed.data.role });

  return { ok: true };
}

function slugify(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || 'org'}-${Date.now().toString(36)}`;
}
