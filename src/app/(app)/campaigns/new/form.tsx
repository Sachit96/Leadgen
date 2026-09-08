'use client';

import { useRouter } from 'next/navigation';
import { Field, inputClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionForm } from '@/components/ui/action-form';
import { createCampaignAction } from '@/app/actions/campaigns';

export function NewCampaignForm() {
  const router = useRouter();

  return (
    <ActionForm
      action={createCampaignAction}
      successMessage="Campaign created"
      onSuccess={(data) => router.push(`/campaigns/${data.id}`)}
      className="space-y-4"
    >
      <Field label="Name" htmlFor="name">
        <input
          id="name"
          name="name"
          required
          autoFocus
          defaultValue="Roofing — Old Lead Recovery"
          className={inputClass}
        />
      </Field>

      <Field label="Industry" htmlFor="industry" hint="Used as the default audience filter.">
        <input id="industry" name="industry" defaultValue="Roofing" className={inputClass} />
      </Field>

      <Field label="Positioning" htmlFor="description">
        <textarea
          id="description"
          name="description"
          rows={2}
          defaultValue="We help roofing companies recover opportunities from leads and estimates that went cold."
          className={inputClass}
        />
      </Field>

      <Field
        label="Message strategy"
        htmlFor="messageStrategy"
        hint="Guidance the AI follows for this campaign specifically."
      >
        <textarea
          id="messageStrategy"
          name="messageStrategy"
          rows={2}
          defaultValue="Open with a specific, low-friction question about old estimates. Discovery before pitch."
          className={inputClass}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Daily capacity"
          htmlFor="dailyCapacity"
          hint="Maximum messages this campaign sends per day."
        >
          <input
            id="dailyCapacity"
            name="dailyCapacity"
            type="number"
            min={1}
            defaultValue={50}
            className={inputClass}
          />
        </Field>
        <Field
          label="Minimum score"
          htmlFor="minScore"
          hint="Leave blank to accept any prospect."
        >
          <input id="minScore" name="minScore" type="number" min={0} max={100} className={inputClass} />
        </Field>
      </div>

      <div className="flex justify-end border-t border-ink-800 pt-3">
        <Button type="submit" variant="primary">
          Create campaign
        </Button>
      </div>
    </ActionForm>
  );
}
