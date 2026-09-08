'use client';

import { useState } from 'react';
import type { OrgConfig } from '@/lib/services/settings';
import type { integrationStatus } from '@/lib/env';
import type { UserRole } from '@/lib/db/types';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import { Badge, Card, Field, Stat, cn, inputClass, selectClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionButton, ActionForm } from '@/components/ui/action-form';
import {
  retryDeadJobAction,
  saveOfferSettings,
  saveScoringSettings,
  saveSendingSettings,
  unsuppressAction,
} from '@/app/actions/settings';
import { InviteForm } from './invite-form';

type Integrations = ReturnType<typeof integrationStatus>;

const TABS = ['offer', 'sending', 'scoring', 'integrations', 'queue', 'team'] as const;
type Tab = (typeof TABS)[number];

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

export function SettingsTabs({
  config,
  integrations,
  queue,
  deadJobs,
  suppression,
  team,
  numbers,
  canWrite,
  role,
}: {
  config: OrgConfig;
  integrations: Integrations;
  queue: { pending: number; processing: number; succeeded: number; dead: number; cancelled: number };
  deadJobs: Array<{ id: string; lastError: string | null; attempts: number; completedAt: string | null }>;
  suppression: Array<{ id: string; phone: string; reason: string; note: string | null; createdAt: string }>;
  team: Array<{ userId: string; name: string; email: string; role: UserRole }>;
  numbers: Array<{ id: string; number: string; label: string | null; active: boolean; dailyCap: number }>;
  canWrite: boolean;
  role: UserRole;
}) {
  const [tab, setTab] = useState<Tab>('offer');

  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-1 border-b border-ink-700">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            aria-pressed={tab === item}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors',
              tab === item
                ? 'border-accent-500 font-medium text-ink-100'
                : 'border-transparent text-ink-500 hover:text-ink-300',
            )}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === 'offer' ? (
        <Card className="max-w-2xl">
          <p className="mb-4 text-sm text-ink-400">
            These are the only pricing figures the AI may state. It is instructed never to quote
            anything else, and never to imply a guarantee or contract length that is blank here.
          </p>
          <ActionForm action={saveOfferSettings} successMessage="Offer saved" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Company name" htmlFor="companyName">
                <input id="companyName" name="companyName" defaultValue={config.offer.companyName} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Product name" htmlFor="productName">
                <input id="productName" name="productName" defaultValue={config.offer.productName} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Setup fee" htmlFor="setup" hint="One-time.">
                <input id="setup" name="setup" defaultValue={(config.offer.setupCents / 100).toFixed(2)} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Monthly fee" htmlFor="monthly">
                <input id="monthly" name="monthly" defaultValue={(config.offer.monthlyCents / 100).toFixed(2)} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Currency" htmlFor="currency">
                <input id="currency" name="currency" defaultValue={config.offer.currency} className={inputClass} readOnly={!canWrite} />
              </Field>
            </div>

            <Field label="One-liner" htmlFor="oneLiner" hint="How the agent describes what you do.">
              <textarea id="oneLiner" name="oneLiner" rows={2} defaultValue={config.offer.oneLiner} className={inputClass} readOnly={!canWrite} />
            </Field>

            <Field
              label="Guarantee"
              htmlFor="guarantee"
              hint="Leave blank and the agent is explicitly told never to promise or imply one."
            >
              <input id="guarantee" name="guarantee" defaultValue={config.offer.guarantee} className={inputClass} readOnly={!canWrite} />
            </Field>

            <Field
              label="Contract terms"
              htmlFor="contractTerms"
              hint="Leave blank and the agent will never state a contract length."
            >
              <input id="contractTerms" name="contractTerms" defaultValue={config.offer.contractTerms} className={inputClass} readOnly={!canWrite} />
            </Field>

            {canWrite ? (
              <div className="flex justify-end border-t border-ink-800 pt-3">
                <Button type="submit" variant="primary">
                  Save offer
                </Button>
              </div>
            ) : null}
          </ActionForm>
        </Card>
      ) : null}

      {tab === 'sending' ? (
        <Card className="max-w-2xl">
          <p className="mb-4 text-sm text-ink-400">
            Operational limits, re-checked at send time rather than only when a message is queued —
            a job that has been waiting hours is held to the rules as they are now.
          </p>
          <ActionForm action={saveSendingSettings} successMessage="Sending rules saved" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Daily cap (whole org)" htmlFor="dailyOrgCap">
                <input id="dailyOrgCap" name="dailyOrgCap" type="number" min={0} defaultValue={config.sending.dailyOrgCap} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Contact cooldown (min)" htmlFor="contactCooldownMinutes">
                <input id="contactCooldownMinutes" name="contactCooldownMinutes" type="number" min={0} defaultValue={config.sending.contactCooldownMinutes} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Max automated / contact / day" htmlFor="maxAutomatedPerContactPerDay">
                <input id="maxAutomatedPerContactPerDay" name="maxAutomatedPerContactPerDay" type="number" min={1} defaultValue={config.sending.maxAutomatedPerContactPerDay} className={inputClass} readOnly={!canWrite} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Quiet hours start" htmlFor="quietHoursStart" hint="Nothing automated sends after this, prospect-local.">
                <input id="quietHoursStart" name="quietHoursStart" type="time" defaultValue={config.sending.quietHoursStart} className={inputClass} readOnly={!canWrite} />
              </Field>
              <Field label="Quiet hours end" htmlFor="quietHoursEnd">
                <input id="quietHoursEnd" name="quietHoursEnd" type="time" defaultValue={config.sending.quietHoursEnd} className={inputClass} readOnly={!canWrite} />
              </Field>
            </div>

            <fieldset>
              <legend className="mb-1 text-xs font-medium text-ink-300">Sending days</legend>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((day) => (
                  <label
                    key={day.value}
                    className="flex cursor-pointer items-center gap-1 rounded border border-ink-600 px-2 py-1 text-xs text-ink-300 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-600/20 has-[:checked]:text-accent-400"
                  >
                    <input
                      type="checkbox"
                      name="sendingDays"
                      value={day.value}
                      defaultChecked={config.sending.sendingDays.includes(day.value)}
                      disabled={!canWrite}
                      className="sr-only"
                    />
                    {day.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                name="includeOptOutFooter"
                defaultChecked={config.sending.includeOptOutFooter}
                disabled={!canWrite}
                className="mt-0.5 size-3.5 accent-blue-500"
              />
              <span>
                <span className="block text-sm text-ink-200">
                  Append an opt-out line to the first message of every sequence
                </span>
                <span className="block text-xs text-ink-500">
                  A STOP reply always registers whether or not this is on — this just makes the route
                  out visible.
                </span>
              </span>
            </label>

            <Field label="Opt-out line" htmlFor="optOutFooter">
              <input id="optOutFooter" name="optOutFooter" defaultValue={config.sending.optOutFooter} className={inputClass} readOnly={!canWrite} />
            </Field>

            {canWrite ? (
              <div className="flex justify-end border-t border-ink-800 pt-3">
                <Button type="submit" variant="primary">
                  Save sending rules
                </Button>
              </div>
            ) : null}
          </ActionForm>
        </Card>
      ) : null}

      {tab === 'scoring' ? (
        <div className="max-w-3xl space-y-4">
          <Card>
            <p className="mb-3 text-sm text-ink-400">
              The scoring engine is data. Change the weights, disable a rule, or adjust the buckets —
              every prospect scored afterwards records which version produced its score.
            </p>
            <ActionForm action={saveScoringSettings} successMessage="Scoring saved" className="space-y-3">
              <textarea
                name="scoring"
                rows={22}
                spellCheck={false}
                defaultValue={JSON.stringify(config.scoring, null, 2)}
                readOnly={!canWrite}
                className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs text-ink-200 focus:border-accent-500 focus:outline-none"
              />
              {canWrite ? (
                <div className="flex justify-end">
                  <Button type="submit" variant="primary">
                    Save scoring rules
                  </Button>
                </div>
              ) : null}
            </ActionForm>
          </Card>

          <Card>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Current rules
            </p>
            <ul className="space-y-1">
              {config.scoring.rules.map((rule) => (
                <li key={rule.key} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className={rule.enabled ? 'text-ink-200' : 'text-ink-600 line-through'}>
                    {rule.label}
                    <span className="ml-2 text-xs text-ink-500">{rule.description}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-300">+{rule.points}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      {tab === 'integrations' ? (
        <div className="max-w-3xl space-y-4">
          <IntegrationCard
            title="SMS"
            configured={integrations.sms.effective !== 'mock'}
            effective={integrations.sms.effective}
            selected={integrations.sms.selected}
            envKeys={
              integrations.sms.selected === 'telnyx'
                ? ['TELNYX_API_KEY', 'TELNYX_PHONE_NUMBER', 'TELNYX_PUBLIC_KEY']
                : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']
            }
            note="Until a provider is configured, messages go to an in-process mock. The queue, delivery tracking, guardrails and analytics all behave identically — nothing reaches a real phone."
          />
          <IntegrationCard
            title="AI"
            configured={integrations.ai.effective !== 'mock'}
            effective={integrations.ai.effective}
            selected={integrations.ai.selected}
            envKeys={['ANTHROPIC_API_KEY', 'AI_MODEL_FAST', 'AI_MODEL_SMART']}
            note="Without a key the agent returns deterministic mock replies so the conversation engine stays exercisable."
          />
          <IntegrationCard
            title="Calendar"
            configured={integrations.calendar.effective === 'google'}
            effective={integrations.calendar.effective}
            selected={integrations.calendar.selected}
            envKeys={['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID']}
            note="Appointments are always stored in On Radar. Connecting Google mirrors them outward and factors your real free/busy into proposed slots."
          />

          <Card>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Sending numbers
            </p>
            {numbers.length === 0 ? (
              <p className="text-sm text-ink-500">
                No numbers registered. Inbound webhooks route to this organization by the number they
                were sent to; with a single organization that is unambiguous anyway.
              </p>
            ) : (
              <ul className="space-y-1">
                {numbers.map((number) => (
                  <li key={number.id} className="flex items-center gap-2 text-sm">
                    <span className="tabular-nums text-ink-200">{formatPhone(number.number)}</span>
                    <span className="text-xs text-ink-500">{number.label}</span>
                    <Badge tone={number.active ? 'positive' : 'neutral'}>
                      {number.active ? 'active' : 'inactive'}
                    </Badge>
                    <span className="ml-auto text-xs text-ink-500">cap {number.dailyCap}/day</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Webhook endpoints
            </p>
            <dl className="space-y-1 font-mono text-xs text-ink-300">
              <div>POST /api/webhooks/sms/inbound</div>
              <div>POST /api/webhooks/sms/status</div>
              <div>POST /api/worker/tick — requires WORKER_TOKEN</div>
            </dl>
            <p className="mt-2 text-xs text-ink-500">
              Both webhooks verify the provider signature and are idempotent: a retry of an event
              already processed is recorded and discarded rather than duplicated.
            </p>
          </Card>
        </div>
      ) : null}

      {tab === 'queue' ? (
        <div className="space-y-4" id="queue">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Pending" value={queue.pending} />
            <Stat label="Processing" value={queue.processing} />
            <Stat label="Sent" value={queue.succeeded} tone="positive" />
            <Stat label="Dead-lettered" value={queue.dead} tone={queue.dead > 0 ? 'danger' : 'neutral'} />
            <Stat label="Cancelled" value={queue.cancelled} />
          </div>

          <Card>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Dead-lettered messages
            </p>
            {deadJobs.length === 0 ? (
              <p className="text-sm text-ink-500">
                Nothing has exhausted its retries. Jobs retry with exponential backoff and only
                dead-letter on a permanent provider error or after the final attempt.
              </p>
            ) : (
              <ul className="divide-y divide-ink-800">
                {deadJobs.map((job) => (
                  <li key={job.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-danger-400">
                      {job.lastError ?? 'Unknown error'}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-500">
                      {job.attempts} attempts · {job.completedAt ? formatRelative(new Date(job.completedAt)) : '—'}
                    </span>
                    {canWrite ? (
                      <ActionButton
                        action={() => retryDeadJobAction(job.id)}
                        successMessage="Requeued"
                        className="shrink-0 rounded border border-ink-600 px-2 py-0.5 text-xs text-ink-300 hover:border-ink-500"
                      >
                        Retry
                      </ActionButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Do-not-contact list ({suppression.length})
            </p>
            {suppression.length === 0 ? (
              <p className="text-sm text-ink-500">Nobody has opted out.</p>
            ) : (
              <ul className="max-h-96 divide-y divide-ink-800 overflow-y-auto">
                {suppression.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-3 py-2">
                    <span className="tabular-nums text-sm text-ink-200">{formatPhone(entry.phone)}</span>
                    <Badge tone={entry.reason === 'OPT_OUT' ? 'danger' : 'neutral'}>
                      {entry.reason.toLowerCase().replace('_', ' ')}
                    </Badge>
                    {entry.note ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-500">{entry.note}</span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    <span className="shrink-0 text-[11px] text-ink-500">
                      {formatRelative(new Date(entry.createdAt))}
                    </span>
                    {canWrite && entry.reason !== 'OPT_OUT' ? (
                      <ActionButton
                        action={() => unsuppressAction(entry.phone)}
                        confirm="Remove this number from the do-not-contact list?"
                        successMessage="Removed"
                        className="shrink-0 text-xs text-ink-400 hover:text-ink-200"
                      >
                        Remove
                      </ActionButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-500">
              Numbers that opted out themselves cannot be removed here — that consent is theirs to
              give back, not yours to take.
            </p>
          </Card>
        </div>
      ) : null}

      {tab === 'team' ? (
        <div className="max-w-2xl space-y-4">
          <Card padded={false}>
            <ul className="divide-y divide-ink-800">
              {team.map((member) => (
                <li key={member.userId} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink-100">{member.name}</p>
                    <p className="truncate text-xs text-ink-500">{member.email}</p>
                  </div>
                  <Badge tone={member.role === 'OWNER' ? 'accent' : 'neutral'} className="ml-auto">
                    {member.role.replace('_', ' ').toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>

          {canWrite ? <InviteForm /> : (
            <p className="text-sm text-ink-500">
              Your role ({role.toLowerCase().replace('_', ' ')}) cannot add team members.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function IntegrationCard({
  title,
  configured,
  effective,
  selected,
  envKeys,
  note,
}: {
  title: string;
  configured: boolean;
  effective: string;
  selected: string;
  envKeys: string[];
  note: string;
}) {
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-medium text-ink-100">{title}</h3>
        <Badge tone={configured ? 'positive' : 'warning'}>
          {configured ? `live · ${effective}` : `mock (selected: ${selected})`}
        </Badge>
      </div>
      <p className="text-sm text-ink-400">{note}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {envKeys.map((key) => (
          <code key={key} className="rounded bg-ink-900 px-1.5 py-0.5 font-mono text-[11px] text-ink-400">
            {key}
          </code>
        ))}
      </div>
    </Card>
  );
}
