'use client';

import { useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/core/errors';
import { useToast } from './toast';
import { cn } from './primitives';

export type ServerAction<T> = (form: FormData) => Promise<ActionResult<T>>;

/**
 * Submits a form to a server action that returns a result object rather than
 * throwing.
 *
 * Everything the app mutates goes through this: it disables the form while in
 * flight (so nothing is submitted twice), surfaces the error message the action
 * chose to expose, and refreshes server data on success.
 */
export function ActionForm<T>({
  action,
  children,
  successMessage,
  onSuccess,
  className,
  confirm,
  resetOnSuccess = false,
  refresh = true,
}: {
  action: ServerAction<T>;
  children: React.ReactNode;
  successMessage?: string;
  onSuccess?: (data: T) => void;
  className?: string;
  confirm?: string;
  resetOnSuccess?: boolean;
  refresh?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        if (confirm && !window.confirm(confirm)) return;

        const form = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await action(form);
          if (result.ok) {
            if (successMessage) toast.push(successMessage, 'success');
            if (resetOnSuccess) formRef.current?.reset();
            if (refresh) router.refresh();
            onSuccess?.(result.data);
          } else {
            toast.push(result.error, 'error');
          }
        });
      }}
    >
      <fieldset disabled={pending} className={cn('contents', pending && 'opacity-70')}>
        {children}
      </fieldset>
    </form>
  );
}

/** Fires a parameterless server action from a button. */
export function ActionButton<T>({
  action,
  children,
  successMessage,
  className,
  confirm,
  onSuccess,
  title,
}: {
  action: () => Promise<ActionResult<T>>;
  children: React.ReactNode;
  successMessage?: string;
  className?: string;
  confirm?: string;
  onSuccess?: (data: T) => void;
  title?: string;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  return (
    <button
      type="button"
      title={title}
      disabled={pending}
      className={className}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        startTransition(async () => {
          const result = await action();
          if (result.ok) {
            if (successMessage) toast.push(successMessage, 'success');
            router.refresh();
            onSuccess?.(result.data);
          } else {
            toast.push(result.error, 'error');
          }
        });
      }}
    >
      {pending ? '…' : children}
    </button>
  );
}
