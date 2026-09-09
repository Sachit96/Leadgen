'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DISPOSITION_LABELS, NOT_INTERESTED_REASONS, PRIMARY_DISPOSITIONS, SKIP_REASONS } from '@/lib/constants/enums';
import type { PrimaryDisposition } from '@/lib/constants/enums';
import { Badge, Card, cn, inputClass, selectClass } from '@/components/ui/primitives';
import { ScoreBadge } from '@/components/ui/status';
import { Button } from '@/components/ui/buttons';
import { buttonClass } from '@/components/ui/button-styles';
import { useToast } from '@/components/ui/toast';
import { initiateCallAction, recordDispositionAction, skipQueueItemAction } from '@/app/actions/calls';

export type CallCard = {
  contactId: string;
  phone: string;
  dialUri: string | null;
  contactName: string | null;
  score: number | null;
  scoreBucket: string | null;
  phoneConfidence: number | null;
  phoneValidated: boolean;
  callAttemptCount: number;
  noAnswerCount: number;
  companyName: string | null;
  category: string | null;
  city: string | null;
  province: string | null;
  addressLine: string | null;
  website: string | null;
  websiteDomain: string | null;
  rating: number | null;
  reviews: number | null;
  ownerName: string | null;
  researchSummary: string | null;
  painPoints: string[];
  dataCompleteness: number | null;
  callOpener: string | null;
  hook: string | null;
  history: Array<{
    id: string;
    outcome: string;
    note: string | null;
    startedAt: string;
    connectionReported: boolean;
  }>;
};

const DISPOSITION_STYLE: Record<PrimaryDisposition, string> = {
  BOOKED: 'border-positive-500/50 bg-positive-500/15 text-positive-400 hover:bg-positive-500/25',
  NO_ANSWER: 'border-ink-600 bg-ink-800 text-ink-200 hover:bg-ink-750',
  CALLBACK: 'border-warning-500/50 bg-warning-500/15 text-warning-400 hover:bg-warning-500/25',
  NOT_INTERESTED: 'border-ink-600 bg-ink-800 text-ink-300 hover:bg-ink-750',
  WRONG_NUMBER: 'border-danger-500/50 bg-danger-500/10 text-danger-400 hover:bg-danger-500/20',
};

/**
 * The call screen.
 *
 * One lead, one number, five outcomes. The rule this screen exists to enforce:
 * pressing the number tells the operating system to dial and tells us nothing
 * else. The app records that the call was STARTED, and every outcome after that
 * is the operator's word — labelled as such, never dressed up as telemetry.
 */
export function CallView({
  queue,
  position,
  card,
  providerReportsConnection,
  canCall,
}: {
  queue: { id: string; name: string };
  position: { itemId: string; contactId: string; index: number; total: number };
  card: CallCard;
  providerReportsConnection: boolean;
  canCall: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<PrimaryDisposition | null>(null);
  const [note, setNote] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [notInterestedReason, setNotInterestedReason] = useState<string>(NOT_INTERESTED_REASONS[0]);

  const location = [card.city, card.province].filter(Boolean).join(', ');

  async function startCall() {
    if (pending) return;
    setPending(true);
    try {
      const result = await initiateCallAction(card.contactId, queue.id, position.itemId);
      if (!result.ok) {
        toast.push(result.error, 'error');
        return;
      }
      setAttemptId(result.data.attemptId);
      // The browser hands the number to the OS. Whether a call actually
      // happens after this point is not something the app can observe.
      if (result.data.uri) window.location.href = result.data.uri;
    } finally {
      setPending(false);
    }
  }

  async function submit(chosen: PrimaryDisposition) {
    if (pending) return;
    if (chosen === 'CALLBACK' && !callbackAt) {
      setOutcome('CALLBACK');
      toast.push('Pick a date and time for the callback', 'error');
      return;
    }

    setPending(true);
    try {
      const form = new FormData();
      form.set('contactId', card.contactId);
      form.set('outcome', chosen);
      form.set('queueItemId', position.itemId);
      if (attemptId) form.set('attemptId', attemptId);
      if (note.trim()) form.set('note', note.trim());
      if (chosen === 'CALLBACK') form.set('callbackAt', new Date(callbackAt).toISOString());
      if (chosen === 'NOT_INTERESTED') form.set('notInterestedReason', notInterestedReason);

      const result = await recordDispositionAction(form);
      if (!result.ok) {
        toast.push(result.error, 'error');
        return;
      }

      toast.push(`${DISPOSITION_LABELS[chosen]} — next lead`, 'success');
      setAttemptId(null);
      setOutcome(null);
      setNote('');
      setCallbackAt('');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function skip(reason: string) {
    setPending(true);
    try {
      const result = await skipQueueItemAction(position.itemId, reason);
      if (!result.ok) {
        toast.push(result.error, 'error');
        return;
      }
      toast.push('Skipped — the lead stays in the CRM', 'success');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/calls" className="text-xs text-ink-500 hover:text-ink-300">
            ← {queue.name}
          </Link>
          <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-ink-100">
            {position.index} of {position.total} in queue
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/prospects/${card.contactId}`} className={buttonClass('ghost', 'sm')}>
            Full record
          </Link>
          <SkipMenu onSkip={skip} disabled={!canCall || pending} />
        </div>
      </div>

      <Card className="text-center" padded>
        <p className="text-xs uppercase tracking-wider text-ink-500">{card.category ?? 'Uncategorised'}</p>
        <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
          {card.companyName ?? card.contactName ?? 'Unnamed business'}
        </h1>

        <p className="mt-1.5 text-sm text-ink-400">
          {card.addressLine ?? location ?? 'Location unknown'}
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {card.score === null ? <Badge>unscored</Badge> : <ScoreBadge score={card.score} bucket={card.scoreBucket} />}
          {card.rating !== null ? (
            <Badge>
              {card.rating.toFixed(1)}★ · {card.reviews ?? 0} reviews
            </Badge>
          ) : (
            <Badge>no rating on file</Badge>
          )}
          {card.ownerName ? <Badge tone="accent">ask for {card.ownerName}</Badge> : null}
          {card.dataCompleteness !== null ? <Badge>{card.dataCompleteness}% complete</Badge> : null}
        </div>

        <div className="mt-6">
          {card.dialUri && canCall ? (
            <button
              type="button"
              onClick={startCall}
              disabled={pending}
              className="inline-flex items-center gap-3 rounded-xl bg-accent-600 px-8 py-5 text-2xl font-semibold tabular-nums tracking-tight text-white transition-colors hover:bg-accent-500 disabled:opacity-60 sm:text-3xl"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-7">
                <path
                  d="M4 5a2 2 0 012-2h2.2a1 1 0 01.97.76l.9 3.6a1 1 0 01-.5 1.12l-1.7.85a12 12 0 006 6l.85-1.7a1 1 0 011.12-.5l3.6.9a1 1 0 01.76.97V17a2 2 0 01-2 2h-1C10.4 19 4 12.6 4 6V5z"
                  strokeLinejoin="round"
                />
              </svg>
              {card.phone}
            </button>
          ) : (
            <div className="inline-flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-800 px-8 py-5 text-2xl font-semibold tabular-nums tracking-tight text-ink-500">
              {card.phone}
            </div>
          )}
        </div>

        <div className="mt-3 space-y-0.5 text-xs text-ink-500">
          {!card.dialUri ? (
            <p className="text-danger-400">This number cannot be dialled — mark it wrong below.</p>
          ) : null}
          <p>
            {card.phoneValidated ? 'Number format validated' : 'Number format not validated'} · source
            confidence {Math.round((card.phoneConfidence ?? 0) * 100)}%
          </p>
          <p>
            {card.callAttemptCount === 0
              ? 'Never called'
              : `${card.callAttemptCount} previous ${card.callAttemptCount === 1 ? 'attempt' : 'attempts'}`}
            {card.noAnswerCount > 0 ? ` · ${card.noAnswerCount} with no answer` : ''}
          </p>
          {attemptId ? (
            <p className="text-accent-400">
              Call started
              {providerReportsConnection
                ? '. Waiting on the provider for call progress.'
                : ' — the app handed the number to your phone. Mark what happened below.'}
            </p>
          ) : null}
        </div>
      </Card>

      {card.callOpener ? (
        <Card className="mt-4">
          <p className="text-xs uppercase tracking-wider text-ink-500">Opening line</p>
          <p className="mt-1.5 text-base leading-relaxed text-ink-100">{card.callOpener}</p>
          {card.hook ? <p className="mt-2 text-xs text-ink-500">Hook: {card.hook}</p> : null}
        </Card>
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <p className="text-xs uppercase tracking-wider text-ink-500">What we know</p>
          {card.researchSummary ? (
            <p className="mt-1.5 text-sm text-ink-300">{card.researchSummary}</p>
          ) : (
            <p className="mt-1.5 text-sm text-ink-500">No research on file.</p>
          )}
          {card.painPoints.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {card.painPoints.map((point) => (
                <li key={point} className="text-sm text-ink-400">
                  · {point}
                </li>
              ))}
            </ul>
          ) : null}
          {card.website ? (
            <a
              href={card.website}
              target="_blank"
              rel="noreferrer noopener nofollow"
              className="mt-2 inline-block text-xs text-accent-400 hover:underline"
            >
              {card.websiteDomain ?? card.website}
            </a>
          ) : null}
        </Card>

        <Card>
          <p className="text-xs uppercase tracking-wider text-ink-500">Call history</p>
          {card.history.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-500">No calls to this number yet.</p>
          ) : (
            <div className="mt-1.5 space-y-2">
              {card.history.map((attempt) => (
                <div key={attempt.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ink-200">
                      {attempt.outcome.replace(/_/g, ' ').toLowerCase()}
                      {attempt.connectionReported ? null : (
                        <span className="ml-1.5 text-[10px] text-ink-600">operator-marked</span>
                      )}
                    </span>
                    <span className="text-xs text-ink-500">
                      {new Date(attempt.startedAt).toLocaleString('en-CA')}
                    </span>
                  </div>
                  {attempt.note ? <p className="mt-0.5 text-xs text-ink-400">{attempt.note}</p> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <p className="text-xs uppercase tracking-wider text-ink-500">How did it go?</p>

        <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {PRIMARY_DISPOSITIONS.map((disposition) => (
            <button
              key={disposition}
              type="button"
              disabled={!canCall || pending}
              onClick={() => {
                if (disposition === 'CALLBACK' || disposition === 'NOT_INTERESTED') {
                  setOutcome((current) => (current === disposition ? null : disposition));
                  return;
                }
                void submit(disposition);
              }}
              className={cn(
                'rounded-lg border px-3 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                DISPOSITION_STYLE[disposition],
                outcome === disposition && 'ring-1 ring-accent-500',
              )}
            >
              {DISPOSITION_LABELS[disposition]}
            </button>
          ))}
        </div>

        {outcome === 'CALLBACK' ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[220px]">
              <span className="mb-1 block text-xs font-medium text-ink-300">Call back at</span>
              <input
                type="datetime-local"
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.target.value)}
                className={inputClass}
              />
            </label>
            <Button variant="primary" disabled={pending} onClick={() => void submit('CALLBACK')}>
              Schedule callback
            </Button>
          </div>
        ) : null}

        {outcome === 'NOT_INTERESTED' ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[220px]">
              <span className="mb-1 block text-xs font-medium text-ink-300">Why not?</span>
              <select
                value={notInterestedReason}
                onChange={(e) => setNotInterestedReason(e.target.value)}
                className={selectClass}
              >
                {NOT_INTERESTED_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="danger" disabled={pending} onClick={() => void submit('NOT_INTERESTED')}>
              Mark not interested
            </Button>
          </div>
        ) : null}

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-ink-300">Note</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did they say?"
            className={inputClass}
          />
        </label>

        <p className="mt-2 text-[11px] text-ink-600">
          Outcomes are recorded as your report of the call. The app does not observe whether a call
          connected{providerReportsConnection ? ' unless your provider reports it' : ''}.
        </p>
      </Card>
    </div>
  );
}

function SkipMenu({ onSkip, disabled }: { onSkip: (reason: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        Skip
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-ink-700 bg-ink-850 p-1 shadow-lg">
          {SKIP_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              onClick={() => {
                setOpen(false);
                onSkip(reason);
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            >
              {reason}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
