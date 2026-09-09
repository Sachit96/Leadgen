'use client';

import Link from 'next/link';
import { ActionButton } from '@/components/ui/action-form';
import { Badge, Card, Meter, type Tone } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { rebuildCallQueueAction, setCallQueueStatusAction } from '@/app/actions/calls';

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'positive',
  PAUSED: 'warning',
  COMPLETED: 'neutral',
  ARCHIVED: 'neutral',
};

export type QueueSummary = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  total: number;
  completed: number;
  skipped: number;
  remaining: number;
  createdAt: Date;
};

export function QueueList({ queues, canWrite }: { queues: QueueSummary[]; canWrite: boolean }) {
  return (
    <div className="space-y-3">
      {queues.map((queue) => (
        <Card key={queue.id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-100">{queue.name}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {queue.description ? `${queue.description} · ` : ''}
                {new Date(queue.createdAt).toLocaleDateString('en-CA')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[queue.status] ?? 'neutral'}>{queue.status.toLowerCase()}</Badge>
              {canWrite ? (
                <>
                  <ActionButton
                    action={() => rebuildCallQueueAction(queue.id)}
                    successMessage="Queue topped up"
                    className={buttonClass('ghost', 'sm')}
                    title="Add newly call-ready leads that match this queue's filters"
                  >
                    Top up
                  </ActionButton>
                  <ActionButton
                    action={() =>
                      setCallQueueStatusAction(queue.id, queue.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')
                    }
                    successMessage={queue.status === 'ACTIVE' ? 'Queue paused' : 'Queue active'}
                    className={buttonClass('ghost', 'sm')}
                  >
                    {queue.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                  </ActionButton>
                </>
              ) : null}
              <Link
                href={`/calls/${queue.id}`}
                className={buttonClass(queue.remaining > 0 ? 'primary' : 'secondary', 'sm')}
              >
                {queue.remaining > 0 ? `Call (${queue.remaining} left)` : 'Review'}
              </Link>
            </div>
          </div>

          <div className="mt-3">
            <Meter
              label="Worked"
              value={queue.completed + queue.skipped}
              max={Math.max(queue.total, 1)}
              tone="accent"
              caption={`of ${queue.total} · ${queue.skipped} skipped`}
            />
          </div>
        </Card>
      ))}
    </div>
  );
}
