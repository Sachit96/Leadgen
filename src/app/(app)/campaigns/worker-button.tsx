'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/buttons';
import { useToast } from '@/components/ui/toast';
import { runWorkerNow } from '@/app/actions/campaigns';

/**
 * The worker runs on its own interval; this is for operators who want the next
 * batch to go out now rather than waiting for the next tick.
 */
export function WorkerButton() {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await runWorkerNow();
          if (!result.ok) {
            toast.push(result.error, 'error');
            return;
          }
          const { sends, sequences, ai } = result.data;
          toast.push(
            `Queued ${sequences.queued}, sent ${sends.sent}, AI replied ${ai.replied}`,
            'success',
          );
          router.refresh();
        })
      }
    >
      {pending ? 'Running…' : 'Run sending now'}
    </Button>
  );
}
