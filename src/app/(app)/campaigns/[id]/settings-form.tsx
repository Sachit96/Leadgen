'use client';

import type { Campaign } from '@/lib/db/types';
import { Card, Field, inputClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionForm } from '@/components/ui/action-form';
import { updateCampaignAction } from '@/app/actions/campaigns';

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

export function CampaignSettingsForm({
  campaign,
  canWrite,
}: {
  campaign: Campaign;
  canWrite: boolean;
}) {
  const sendingDays = Array.isArray(campaign.sendingDays)
    ? (campaign.sendingDays as number[])
    : [1, 2, 3, 4, 5];

  return (
    <Card>
      <ActionForm action={updateCampaignAction} successMessage="Campaign updated" className="space-y-3">
        <input type="hidden" name="id" value={campaign.id} />

        <Field label="Name" htmlFor="campaign-name">
          <input id="campaign-name" name="name" defaultValue={campaign.name} className={inputClass} readOnly={!canWrite} />
        </Field>

        <Field label="Industry" htmlFor="campaign-industry">
          <input id="campaign-industry" name="industry" defaultValue={campaign.industry ?? ''} className={inputClass} readOnly={!canWrite} />
        </Field>

        <Field label="Positioning" htmlFor="campaign-description">
          <textarea id="campaign-description" name="description" rows={2} defaultValue={campaign.description ?? ''} className={inputClass} readOnly={!canWrite} />
        </Field>

        <Field label="Message strategy" htmlFor="campaign-strategy">
          <textarea id="campaign-strategy" name="messageStrategy" rows={2} defaultValue={campaign.messageStrategy ?? ''} className={inputClass} readOnly={!canWrite} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Window opens" htmlFor="windowStart">
            <input id="windowStart" name="sendingWindowStart" type="time" defaultValue={campaign.sendingWindowStart} className={inputClass} readOnly={!canWrite} />
          </Field>
          <Field label="Window closes" htmlFor="windowEnd">
            <input id="windowEnd" name="sendingWindowEnd" type="time" defaultValue={campaign.sendingWindowEnd} className={inputClass} readOnly={!canWrite} />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-300">Sending days</legend>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((day) => (
              <label
                key={day.value}
                className="flex cursor-pointer items-center gap-1 rounded border border-ink-600 px-1.5 py-0.5 text-xs text-ink-300 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-600/20 has-[:checked]:text-accent-400"
              >
                <input
                  type="checkbox"
                  name="sendingDays"
                  value={day.value}
                  defaultChecked={sendingDays.includes(day.value)}
                  disabled={!canWrite}
                  className="sr-only"
                />
                {day.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Daily capacity" htmlFor="dailyCapacity">
            <input id="dailyCapacity" name="dailyCapacity" type="number" min={1} defaultValue={campaign.dailyCapacity} className={inputClass} readOnly={!canWrite} />
          </Field>
          <Field label="Min score" htmlFor="minScore">
            <input id="minScore" name="minScore" type="number" min={0} max={100} defaultValue={campaign.minScore ?? ''} className={inputClass} readOnly={!canWrite} />
          </Field>
        </div>

        <Field label="Timezone" htmlFor="timezone" hint="Sending windows follow this clock.">
          <input id="timezone" name="timezone" defaultValue={campaign.timezone} className={inputClass} readOnly={!canWrite} />
        </Field>

        {canWrite ? (
          <Button type="submit" variant="primary" className="w-full">
            Save settings
          </Button>
        ) : null}
      </ActionForm>
    </Card>
  );
}
