'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type {
  Activity,
  AiSummary,
  Company,
  Contact,
  Conversation,
  Message,
} from '@/lib/db/types';
import type { QualificationField, QualificationFields } from '@/lib/services/qualification';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import { segmentInfo } from '@/lib/core/template';
import { Badge, Card, KeyValue, cn, inputClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { useToast } from '@/components/ui/toast';
import { ActionForm } from '@/components/ui/action-form';
import {
  ConversationStateBadge,
  MessageStatusLabel,
  ScoreBadge,
  TemperatureBadge,
} from '@/components/ui/status';
import {
  changeState,
  generateSummary,
  markQualified,
  pauseAi,
  resumeAi,
  runAiNow,
  saveQualification,
  sendManualMessage,
  suppressContact,
  takeOver,
} from '@/app/actions/conversations';
import { bookAppointmentAction } from '@/app/actions/pipeline';
import { createTaskAction } from '@/app/actions/tasks';

type Props = {
  conversation: Conversation;
  contact: Contact;
  company: Company | null;
  campaignName: string | null;
  messages: Message[];
  summary: AiSummary | null;
  qualificationFields: QualificationFields;
  qualificationDefinitions: QualificationField[];
  completeness: number;
  activity: Activity[];
  slots: Array<{ startsAt: string; label: string }>;
  facts: string[];
  unknowns: string[];
  canWrite: boolean;
};

/**
 * The whole sales workspace for one conversation: summary, context,
 * qualification, transcript and reply — so a rep never needs a second screen to
 * do the job.
 */
export function ConversationWorkspace(props: Props) {
  const { conversation, contact, company, messages, canWrite } = props;
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [panel, setPanel] = useState<'context' | 'qualification' | 'activity'>('context');
  const threadEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // A reply arriving while the conversation is open should appear without a
  // manual refresh.
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('activity', () => router.refresh());
    source.onerror = () => source.close();
    return () => source.close();
  }, [router]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, successMessage: string) =>
    startTransition(async () => {
      const result = await fn();
      toast.push(result.ok ? successMessage : (result.error ?? 'That did not work'), result.ok ? 'success' : 'error');
      if (result.ok) router.refresh();
    });

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown contact';

  return (
    <div className="flex h-screen">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-ink-700 bg-ink-900 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold text-ink-100">
                  {company?.name ?? name}
                </h1>
                <ConversationStateBadge state={conversation.state} />
                <TemperatureBadge temperature={conversation.leadTemperature} />
                <ScoreBadge score={contact.score} bucket={contact.scoreBucket} />
              </div>
              <p className="mt-0.5 text-xs text-ink-400">
                {name} · {formatPhone(contact.phone)}
                {company?.city ? ` · ${company.city}` : ''}
                {props.campaignName ? ` · ${props.campaignName}` : ''}
              </p>
            </div>

            {canWrite ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {conversation.aiEnabled ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => pauseAi(conversation.id), 'AI paused')}
                  >
                    Pause AI
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => resumeAi(conversation.id), 'AI resumed')}
                  >
                    Resume AI
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => takeOver(conversation.id), 'You have taken over')}
                >
                  Take over
                </Button>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(() => markQualified(conversation.id, contact.id), 'Marked qualified')
                  }
                >
                  Mark qualified
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => runAiNow(conversation.id), 'AI replied')}
                >
                  AI reply now
                </Button>
              </div>
            ) : null}
          </div>

          {conversation.requiresHuman ? (
            <div className="mt-2 flex items-center gap-2 rounded border border-warning-500/40 bg-warning-500/10 px-2.5 py-1.5 text-xs text-warning-400">
              <span className="font-medium">Waiting on a human:</span>
              <span>{conversation.handoffReason ?? 'the AI escalated this conversation'}</span>
            </div>
          ) : null}

          {!conversation.aiEnabled && !conversation.requiresHuman ? (
            <p className="mt-2 text-xs text-ink-500">
              AI is paused{conversation.aiPausedReason ? ` — ${conversation.aiPausedReason}` : ''}.
            </p>
          ) : null}
        </header>

        <Thread messages={messages} endRef={threadEnd} />

        {canWrite ? (
          <Composer conversationId={conversation.id} onSent={() => router.refresh()} />
        ) : (
          <div className="border-t border-ink-700 px-4 py-3 text-xs text-ink-500">
            Your role can read conversations but not reply.
          </div>
        )}
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-ink-700 bg-ink-900">
        <div className="flex border-b border-ink-700">
          {(['context', 'qualification', 'activity'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setPanel(tab)}
              aria-pressed={panel === tab}
              className={cn(
                'flex-1 border-b-2 px-2 py-2 text-xs font-medium capitalize transition-colors',
                panel === tab
                  ? 'border-accent-500 text-ink-100'
                  : 'border-transparent text-ink-500 hover:text-ink-300',
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {panel === 'context' ? (
            <ContextPanel {...props} onAction={run} pending={pending} />
          ) : null}
          {panel === 'qualification' ? <QualificationPanel {...props} /> : null}
          {panel === 'activity' ? <ActivityPanel activity={props.activity} /> : null}
        </div>
      </aside>
    </div>
  );
}

function Thread({
  messages,
  endRef,
}: {
  messages: Message[];
  endRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
      {messages.map((message, index) => {
        const inbound = message.direction === 'INBOUND';
        const previous = messages[index - 1];
        const showDay =
          !previous ||
          new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();

        return (
          <div key={message.id}>
            {showDay ? (
              <div className="my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-ink-800" />
                <span className="text-[11px] text-ink-500">
                  {new Date(message.createdAt).toLocaleDateString('en-CA', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <div className="h-px flex-1 bg-ink-800" />
              </div>
            ) : null}

            <div className={cn('flex', inbound ? 'justify-start' : 'justify-end')}>
              <div className={cn('max-w-[75%]', inbound ? 'items-start' : 'items-end')}>
                <div
                  className={cn(
                    'whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                    inbound
                      ? 'bg-ink-800 text-ink-100'
                      : message.author === 'AI'
                        ? 'bg-accent-600/20 text-ink-100 ring-1 ring-inset ring-accent-600/40'
                        : 'bg-accent-600 text-white',
                  )}
                >
                  {message.body}
                </div>
                <div
                  className={cn(
                    'mt-1 flex items-center gap-1.5 text-[10px] text-ink-500',
                    inbound ? 'justify-start' : 'justify-end',
                  )}
                >
                  <span>
                    {new Date(message.createdAt).toLocaleTimeString('en-CA', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  {!inbound ? (
                    <>
                      <span>·</span>
                      <span className="uppercase tracking-wide">
                        {message.author === 'AI' ? 'AI' : message.author === 'SYSTEM' ? 'sequence' : 'you'}
                      </span>
                      <span>·</span>
                      <MessageStatusLabel status={message.status} />
                    </>
                  ) : null}
                </div>
                {message.errorMessage ? (
                  <p className="mt-1 text-right text-[10px] text-danger-400">{message.errorMessage}</p>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function Composer({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const [body, setBody] = useState('');
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const info = segmentInfo(body);

  const send = () => {
    if (!body.trim() || pending) return;
    const form = new FormData();
    form.set('conversationId', conversationId);
    form.set('body', body);

    startTransition(async () => {
      const result = await sendManualMessage(form);
      if (result.ok) {
        setBody('');
        toast.push('Message queued and sent', 'success');
        onSent();
      } else {
        toast.push(result.error, 'error');
      }
    });
  };

  return (
    <div className="border-t border-ink-700 bg-ink-900 p-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. This screen is used all day.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={3}
        placeholder="Write a reply…  (Enter to send, Shift+Enter for a new line)"
        aria-label="Reply"
        className="w-full resize-none rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] tabular-nums text-ink-500">
          {info.characters} chars · {info.segments} segment{info.segments === 1 ? '' : 's'} ·{' '}
          {info.encoding}
        </span>
        <Button variant="primary" size="sm" disabled={pending || !body.trim()} onClick={send}>
          {pending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

function ContextPanel({
  contact,
  company,
  summary,
  slots,
  facts,
  unknowns,
  conversation,
  canWrite,
  onAction,
  pending,
}: Props & {
  onAction: (fn: () => Promise<{ ok: boolean; error?: string }>, message: string) => void;
  pending: boolean;
}) {
  const toast = useToast();
  const [booking, startBooking] = useTransition();

  return (
    <div className="space-y-4">
      {summary ? (
        <Card className="border-accent-600/30 bg-accent-600/5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent-400">
            AI summary
          </p>
          <p className="text-xs leading-relaxed text-ink-200">{summary.summary}</p>
          {summary.painIdentified ? (
            <p className="mt-2 text-xs text-ink-300">
              <span className="text-ink-500">Pain: </span>
              {summary.painIdentified}
            </p>
          ) : null}
          {summary.recommendedNextStep ? (
            <p className="mt-2 rounded bg-ink-850 px-2 py-1.5 text-xs text-ink-200">
              <span className="text-ink-500">Next: </span>
              {summary.recommendedNextStep}
            </p>
          ) : null}
        </Card>
      ) : null}

      {canWrite ? (
        <Button
          size="sm"
          className="w-full"
          disabled={pending}
          onClick={() => onAction(() => generateSummary(conversation.id), 'Summary generated')}
        >
          {summary ? 'Refresh AI summary' : 'Generate AI summary'}
        </Button>
      ) : null}

      <section>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Company
        </p>
        <Card>
          <dl>
            <KeyValue label="Name" value={company?.name ?? '—'} />
            <KeyValue label="City" value={company?.city ?? '—'} />
            <KeyValue label="Industry" value={company?.industry ?? '—'} />
            <KeyValue label="Owner" value={company?.ownerName ?? '—'} />
            <KeyValue
              label="Reviews"
              value={company?.googleReviews ? `${company.googleReviews} (${company.googleRating ?? '—'})` : '—'}
            />
            <KeyValue
              label="Website"
              value={
                company?.website ? (
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent-400 hover:underline"
                  >
                    visit
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <KeyValue label="CRM" value={company?.crmDetected ?? 'none detected'} />
          </dl>
          <Link
            href={`/prospects?q=${encodeURIComponent(contact.phone)}`}
            className="mt-2 block text-xs text-accent-400 hover:underline"
          >
            Open prospect record
          </Link>
        </Card>
      </section>

      <section>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          What the AI may reference
        </p>
        <Card>
          <ul className="space-y-1">
            {facts.length === 0 ? (
              <li className="text-xs text-ink-500">Nothing researched yet.</li>
            ) : (
              facts.map((fact) => (
                <li key={fact} className="text-xs text-ink-300">
                  · {fact}
                </li>
              ))
            )}
          </ul>
          {unknowns.length > 0 ? (
            <p className="mt-2 border-t border-ink-800 pt-2 text-[11px] text-ink-500">
              Unknown (never asserted): {unknowns.join(', ')}
            </p>
          ) : null}
        </Card>
      </section>

      {canWrite ? (
        <section>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Book a call
          </p>
          <Card padded={false}>
            <ul className="divide-y divide-ink-800">
              {slots.slice(0, 5).map((slot) => (
                <li key={slot.startsAt}>
                  <button
                    type="button"
                    disabled={booking}
                    onClick={() =>
                      startBooking(async () => {
                        const form = new FormData();
                        form.set('contactId', contact.id);
                        form.set('conversationId', conversation.id);
                        form.set('startsAt', slot.startsAt);
                        form.set('durationMinutes', '15');
                        form.set('confirmBySms', 'on');
                        const result = await bookAppointmentAction(form);
                        toast.push(
                          result.ok ? `Booked ${slot.label}` : result.error,
                          result.ok ? 'success' : 'error',
                        );
                      })
                    }
                    className="w-full px-3 py-2 text-left text-xs text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100 disabled:opacity-50"
                  >
                    {slot.label}
                  </button>
                </li>
              ))}
              {slots.length === 0 ? (
                <li className="px-3 py-2 text-xs text-ink-500">No slots in the next 5 days.</li>
              ) : null}
            </ul>
          </Card>
        </section>
      ) : null}

      {canWrite ? (
        <section className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Actions</p>
          <ActionForm
            action={createTaskAction}
            successMessage="Task created"
            resetOnSuccess
            className="space-y-1.5"
          >
            <input type="hidden" name="contactId" value={contact.id} />
            <input type="hidden" name="conversationId" value={conversation.id} />
            <input
              name="title"
              placeholder="Add a task…"
              required
              className={inputClass}
              aria-label="Task title"
            />
            <Button type="submit" size="sm" className="w-full">
              Create task
            </Button>
          </ActionForm>

          <select
            aria-label="Change conversation stage"
            value={conversation.state}
            onChange={(e) =>
              onAction(
                () => changeState(conversation.id, e.target.value as typeof conversation.state),
                'Stage updated',
              )
            }
            className={inputClass}
          >
            {[
              'NEW',
              'OPENING',
              'DISCOVERY',
              'PAIN',
              'QUALIFICATION',
              'VALUE',
              'OBJECTION',
              'APPOINTMENT',
              'BOOKED',
              'HUMAN_HANDOFF',
              'NOT_INTERESTED',
              'CLOSED',
            ].map((state) => (
              <option key={state} value={state}>
                {state.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>

          <ActionForm
            action={suppressContact}
            successMessage="Added to do-not-contact"
            confirm="Add this number to the do-not-contact list? All automation stops immediately."
          >
            <input type="hidden" name="phone" value={contact.phone} />
            <input type="hidden" name="contactId" value={contact.id} />
            <Button type="submit" variant="danger" size="sm" className="w-full">
              Do not contact
            </Button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}

function QualificationPanel({
  qualificationFields,
  qualificationDefinitions,
  completeness,
  conversation,
  contact,
  canWrite,
}: Props) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-ink-400">Completeness</span>
          <span className="text-xs font-medium tabular-nums text-ink-200">
            {Math.round(completeness * 100)}%
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-positive-500"
            style={{ width: `${Math.round(completeness * 100)}%` }}
          />
        </div>
      </div>

      <ActionForm action={saveQualification} successMessage="Qualification saved" className="space-y-2.5">
        <input type="hidden" name="conversationId" value={conversation.id} />
        <input type="hidden" name="contactId" value={contact.id} />
        {qualificationDefinitions.map((definition) => {
          const current = qualificationFields[definition.key];
          return (
            <div key={definition.key}>
              <label
                htmlFor={`q_${definition.key}`}
                className="mb-1 flex items-baseline justify-between gap-2"
              >
                <span className="text-[11px] font-medium text-ink-300">{definition.label}</span>
                {current ? (
                  <Badge tone={current.source === 'human' ? 'accent' : 'neutral'}>
                    {current.source}
                  </Badge>
                ) : definition.required ? (
                  <span className="text-[10px] text-ink-600">required</span>
                ) : null}
              </label>
              <input
                id={`q_${definition.key}`}
                name={`q_${definition.key}`}
                defaultValue={current ? String(current.value) : ''}
                placeholder={definition.question}
                readOnly={!canWrite}
                className={inputClass}
              />
            </div>
          );
        })}
        {canWrite ? (
          <Button type="submit" size="sm" variant="primary" className="w-full">
            Save qualification
          </Button>
        ) : null}
      </ActionForm>
    </div>
  );
}

function ActivityPanel({ activity }: { activity: Activity[] }) {
  if (activity.length === 0) {
    return <p className="text-xs text-ink-500">No activity recorded yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {activity.map((item) => (
        <li key={item.id} className="border-l border-ink-700 pl-3">
          <p className="text-xs text-ink-200">{item.title}</p>
          {item.body ? <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-500">{item.body}</p> : null}
          <p className="mt-0.5 text-[10px] text-ink-600">
            {formatRelative(item.createdAt)} · {item.actorKind}
          </p>
        </li>
      ))}
    </ol>
  );
}
