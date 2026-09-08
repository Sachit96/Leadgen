'use client';

import { useRouter } from 'next/navigation';
import { Card, Field, inputClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionForm } from '@/components/ui/action-form';
import { createProspectAction } from '@/app/actions/prospects';

export function NewProspectForm() {
  const router = useRouter();

  return (
    <Card>
      <ActionForm
        action={createProspectAction}
        successMessage="Prospect created"
        onSuccess={(data) => router.push(`/prospects/${data.id}`)}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone" htmlFor="phone" hint="Any format — it is normalized to E.164.">
            <input id="phone" name="phone" required autoFocus className={inputClass} placeholder="(416) 555-0142" />
          </Field>
          <Field label="Email" htmlFor="email">
            <input id="email" name="email" type="email" className={inputClass} />
          </Field>
          <Field label="First name" htmlFor="firstName">
            <input id="firstName" name="firstName" className={inputClass} />
          </Field>
          <Field label="Last name" htmlFor="lastName">
            <input id="lastName" name="lastName" className={inputClass} />
          </Field>
        </div>

        <div className="border-t border-ink-800 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
            Company
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Company name"
              htmlFor="companyName"
              hint="Matched against existing companies so duplicates merge."
            >
              <input id="companyName" name="companyName" className={inputClass} />
            </Field>
            <Field label="Owner" htmlFor="ownerName">
              <input id="ownerName" name="ownerName" className={inputClass} />
            </Field>
            <Field label="Industry" htmlFor="industry">
              <input id="industry" name="industry" className={inputClass} placeholder="Roofing" />
            </Field>
            <Field label="City" htmlFor="city">
              <input id="city" name="city" className={inputClass} />
            </Field>
            <Field label="Province / state" htmlFor="province">
              <input id="province" name="province" className={inputClass} placeholder="ON" />
            </Field>
            <Field label="Website" htmlFor="website">
              <input id="website" name="website" className={inputClass} />
            </Field>
            <Field label="Google reviews" htmlFor="googleReviews">
              <input id="googleReviews" name="googleReviews" type="number" className={inputClass} />
            </Field>
            <Field label="Google rating" htmlFor="googleRating">
              <input id="googleRating" name="googleRating" type="number" step="0.1" className={inputClass} />
            </Field>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-800 pt-3">
          <Button type="submit" variant="primary">
            Create prospect
          </Button>
        </div>
      </ActionForm>
    </Card>
  );
}
