'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { DealRow } from '@/lib/services/pipeline';
import { PIPELINE_STAGES, STAGE_LABELS, type PipelineStage } from '@/lib/constants/enums';
import { formatMoney } from '@/lib/core/money';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import { cn } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { moveDealAction } from '@/app/actions/pipeline';

/**
 * Drag-and-drop board using the native HTML drag API — no dependency, and it
 * keeps keyboard users served by the per-card stage select underneath.
 */
export function PipelineBoard({
  deals,
  currency,
  canWrite,
}: {
  deals: DealRow[];
  currency: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<PipelineStage | null>(null);

  const move = (dealId: string, stage: PipelineStage) => {
    const deal = deals.find((d) => d.deal.id === dealId);
    if (!deal || deal.deal.stage === stage) return;

    let lostReason: string | undefined;
    if (stage === 'LOST') {
      const reason = window.prompt('Why was this lost? (optional)') ?? '';
      lostReason = reason.trim() || undefined;
    }

    startTransition(async () => {
      const result = await moveDealAction(dealId, stage, lostReason);
      toast.push(
        result.ok ? `Moved to ${STAGE_LABELS[stage]}` : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) router.refresh();
    });
  };

  return (
    <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
      {PIPELINE_STAGES.map((stage) => {
        const stageDeals = deals.filter((d) => d.deal.stage === stage);
        const total = stageDeals.reduce((sum, d) => sum + d.deal.valueCents, 0);

        return (
          <div
            key={stage}
            onDragOver={(event) => {
              if (!canWrite) return;
              event.preventDefault();
              setOver(stage);
            }}
            onDragLeave={() => setOver((current) => (current === stage ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              const dealId = event.dataTransfer.getData('text/plain') || dragging;
              if (dealId) move(dealId, stage);
              setDragging(null);
            }}
            className={cn(
              'flex w-64 shrink-0 flex-col rounded-lg border bg-ink-850 transition-colors',
              over === stage ? 'border-accent-500 bg-ink-800' : 'border-ink-700',
            )}
          >
            <div className="flex items-baseline justify-between border-b border-ink-700 px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-300">
                {STAGE_LABELS[stage]}
              </span>
              <span className="text-[11px] tabular-nums text-ink-500">{stageDeals.length}</span>
            </div>

            {total > 0 ? (
              <div className="border-b border-ink-800 px-3 py-1.5 text-[11px] tabular-nums text-ink-400">
                {formatMoney(total, currency)}
              </div>
            ) : null}

            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {stageDeals.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-ink-600">Nothing here</p>
              ) : (
                stageDeals.map(({ deal, contactName, companyName, phone, conversationId }) => (
                  <article
                    key={deal.id}
                    draggable={canWrite}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', deal.id);
                      setDragging(deal.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={cn(
                      'rounded-md border border-ink-700 bg-ink-900 p-2.5',
                      canWrite && 'cursor-grab active:cursor-grabbing',
                      dragging === deal.id && 'opacity-40',
                    )}
                  >
                    <p className="truncate text-sm font-medium text-ink-100">
                      {companyName ?? contactName ?? formatPhone(phone)}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-500">{deal.title}</p>

                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium tabular-nums text-ink-200">
                        {deal.valueCents > 0 ? formatMoney(deal.valueCents, currency) : '—'}
                      </span>
                      <span className="text-[10px] text-ink-600">
                        {formatRelative(deal.updatedAt)}
                      </span>
                    </div>

                    {deal.lostReason ? (
                      <p className="mt-1 text-[10px] text-danger-400">{deal.lostReason}</p>
                    ) : null}

                    <div className="mt-2 flex items-center gap-2 border-t border-ink-800 pt-1.5">
                      {conversationId ? (
                        <Link
                          href={`/inbox/${conversationId}`}
                          className="text-[11px] text-accent-400 hover:underline"
                        >
                          Chat
                        </Link>
                      ) : null}
                      <Link
                        href={`/prospects/${deal.contactId}`}
                        className="text-[11px] text-ink-400 hover:text-ink-200"
                      >
                        Prospect
                      </Link>

                      {canWrite ? (
                        <select
                          aria-label={`Move ${deal.title} to another stage`}
                          value={deal.stage}
                          onChange={(e) => move(deal.id, e.target.value as PipelineStage)}
                          className="ml-auto rounded border border-ink-700 bg-ink-850 px-1 py-0.5 text-[10px] text-ink-400"
                        >
                          {PIPELINE_STAGES.map((option) => (
                            <option key={option} value={option}>
                              {STAGE_LABELS[option]}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
