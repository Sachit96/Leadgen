'use client';

import { useActionState } from 'react';
import { inviteUser, type FormState } from '@/app/actions/auth';
import { Card, Field, inputClass, selectClass } from '@/components/ui/primitives';
import { SubmitButton } from '@/components/ui/buttons';

const initialState: FormState = {};

export function InviteForm() {
  const [state, formAction] = useActionState(inviteUser, initialState);

  return (
    <Card>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
        Add a team member
      </p>
      <form action={formAction} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="invite-name">
            <input id="invite-name" name="name" required className={inputClass} />
          </Field>
          <Field label="Email" htmlFor="invite-email">
            <input id="invite-email" name="email" type="email" required className={inputClass} />
          </Field>
          <Field label="Temporary password" htmlFor="invite-password" hint="At least 8 characters.">
            <input id="invite-password" name="password" type="password" required minLength={8} className={inputClass} />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <select id="invite-role" name="role" defaultValue="SALES_REP" className={selectClass}>
              <option value="ADMIN">Admin — full access except billing</option>
              <option value="SALES_REP">Sales rep — can work prospects and send</option>
              <option value="VIEWER">Viewer — read only</option>
            </select>
          </Field>
        </div>

        {state.error ? (
          <p role="alert" className="rounded border border-danger-500/40 bg-danger-500/10 px-2.5 py-1.5 text-xs text-danger-400">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p role="status" className="rounded border border-positive-500/40 bg-positive-500/10 px-2.5 py-1.5 text-xs text-positive-400">
            Team member added. Ask them to sign in and change their password.
          </p>
        ) : null}

        <SubmitButton pendingLabel="Adding…">Add team member</SubmitButton>
      </form>
    </Card>
  );
}
