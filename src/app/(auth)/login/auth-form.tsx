'use client';

import { useActionState } from 'react';
import { login, signup, type FormState } from '@/app/actions/auth';
import { SubmitButton } from '@/components/ui/buttons';
import { Field, inputClass } from '@/components/ui/primitives';

const initialState: FormState = {};

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const action = mode === 'signup' ? signup : login;
  const [state, formAction] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-ink-700 bg-ink-850 p-5">
      {mode === 'signup' ? (
        <>
          <Field label="Your name" htmlFor="name">
            <input id="name" name="name" required autoComplete="name" className={inputClass} />
          </Field>
          <Field label="Company name" htmlFor="organizationName">
            <input
              id="organizationName"
              name="organizationName"
              required
              defaultValue="On Radar"
              className={inputClass}
            />
          </Field>
        </>
      ) : null}

      <Field label="Email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          className={inputClass}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
      >
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          className={inputClass}
        />
      </Field>

      {state.error ? (
        <p role="alert" className="rounded border border-danger-500/40 bg-danger-500/10 px-2.5 py-1.5 text-xs text-danger-400">
          {state.error}
        </p>
      ) : null}

      <SubmitButton className="w-full" pendingLabel={mode === 'signup' ? 'Creating…' : 'Signing in…'}>
        {mode === 'signup' ? 'Create workspace' : 'Sign in'}
      </SubmitButton>
    </form>
  );
}
