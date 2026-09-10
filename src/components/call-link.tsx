'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from './ui/button-styles';
import { useToast } from './ui/toast';
import { openDialer } from '@/lib/client/dial';
import { initiateCallAction } from '@/app/actions/calls';

/**
 * Click-to-call from anywhere in the app.
 *
 * Records the attempt server-side first — so a call started from a prospect
 * page shows up in the same history as one started from a queue — then hands
 * the number to the operating system. Nothing here claims the call connected.
 */
export function CallLink({
  contactId,
  phone,
  dialUri,
  disabled = false,
  label,
  variant = 'secondary',
}: {
  contactId: string;
  phone: string;
  dialUri: string | null;
  disabled?: boolean;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  if (!dialUri) {
    return (
      <span className={buttonClass('ghost', 'sm')} title="This number cannot be dialled">
        {label ?? phone}
      </span>
    );
  }

  return (
    <a
      href={dialUri}
      aria-disabled={disabled || pending}
      className={buttonClass(variant, 'sm')}
      onClick={async (event) => {
        // Always prevented: dialling goes through openDialer so this page is
        // never navigated. The href stays so the number remains a real link.
        event.preventDefault();
        if (disabled || pending) return;
        setPending(true);
        try {
          const result = await initiateCallAction(contactId);
          if (!result.ok) {
            toast.push(result.error, 'error');
            return;
          }
          router.refresh();
          if (result.data.uri) openDialer(result.data.uri);
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? '…' : (label ?? `Call ${phone}`)}
    </a>
  );
}
