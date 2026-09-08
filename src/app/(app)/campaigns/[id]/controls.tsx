'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CampaignStatus } from '@/lib/db/types';
import { Button } from '@/components/ui/buttons';
import { useToast } from '@/components/ui/toast';
import { setCampaignStatusAction } from '@/app/actions/campaigns';

export function CampaignControls({
  campaignId,
  status,
}: {
  campaignId: string;
  status: CampaignStatus;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const set = (next: CampaignStatus, confirmMessage?: string) =>
    startTransition(async () => {
      if (confirmMessage && !window.confirm(confirmMessage)) return;
      const result = await setCampaignStatusAction(campaignId, next);
      toast.push(
        result.ok ? `Campaign ${next.toLowerCase()}` : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) router.refresh();
    });

  if (status === 'ACTIVE') {
    return (
      <>
        <Button disabled={pending} onClick={() => set('PAUSED')}>
          Pause
        </Button>
        <Button
          disabled={pending}
          onClick={() => set('COMPLETED', 'Mark this campaign complete? It will stop sending.')}
        >
          Complete
        </Button>
      </>
    );
  }

  if (status === 'COMPLETED' || status === 'ARCHIVED') {
    return (
      <Button variant="primary" disabled={pending} onClick={() => set('ACTIVE')}>
        Reactivate
      </Button>
    );
  }

  return (
    <>
      {status === 'PAUSED' ? (
        <Button disabled={pending} onClick={() => set('ARCHIVED')}>
          Archive
        </Button>
      ) : null}
      <Button variant="primary" disabled={pending} onClick={() => set('ACTIVE')}>
        {status === 'PAUSED' ? 'Resume' : 'Activate'}
      </Button>
    </>
  );
}
