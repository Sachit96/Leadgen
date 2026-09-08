import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { destroySession, SESSION_COOKIE } from '@/lib/auth/session';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

export async function POST() {
  const store = await cookies();
  await destroySession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login', env().NEXT_PUBLIC_APP_URL), { status: 303 });
}
