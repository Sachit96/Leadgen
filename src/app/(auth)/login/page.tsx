import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { organizations } from '@/lib/db/schema';
import { getSessionUser } from '@/lib/auth/context';
import { AuthForm } from './auth-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect('/');

  // With no organization yet, this is a fresh instance: offer setup instead of
  // a sign-in form nobody can satisfy.
  const rows = await getDb().select({ count: sql<number>`count(*)::int` }).from(organizations);
  const needsSetup = (rows[0]?.count ?? 0) === 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-3 inline-flex size-11 items-center justify-center rounded-xl border border-accent-600/40 bg-accent-600/15">
            <svg viewBox="0 0 24 24" fill="none" className="size-6 text-accent-400" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-100">On Radar</h1>
          <p className="mt-1 text-sm text-ink-400">
            {needsSetup ? 'Set up your workspace' : 'AI-powered outbound sales'}
          </p>
        </div>

        <AuthForm mode={needsSetup ? 'signup' : 'login'} />
      </div>
    </main>
  );
}
