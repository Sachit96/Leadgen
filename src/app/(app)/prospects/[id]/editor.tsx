'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Company, Contact } from '@/lib/db/types';
import { Card, Field, SectionTitle, inputClass, selectClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionForm } from '@/components/ui/action-form';
import { useToast } from '@/components/ui/toast';
import { generateMessagePreview, researchProspect, updateProspectAction } from '@/app/actions/prospects';
import { MESSAGE_ANGLES } from '@/lib/constants/enums';

export function ProspectEditor({
  contact,
  company,
  canWrite,
}: {
  contact: Contact;
  company: Company | null;
  canWrite: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<{ message: string; rationale: string } | null>(null);
  const [angle, setAngle] = useState('old_estimates');

  const triState = (value: boolean | null) => (value === null ? '' : value ? 'true' : 'false');

  return (
    <section>
      <SectionTitle
        action={
          canWrite ? (
            <div className="flex items-center gap-2">
              <select
                aria-label="Message angle"
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
                className="rounded border border-ink-600 bg-ink-900 px-1.5 py-0.5 text-xs"
              >
                {MESSAGE_ANGLES.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await generateMessagePreview(contact.id, angle);
                    if (result.ok) setPreview(result.data);
                    else toast.push(result.error, 'error');
                  })
                }
              >
                Preview message
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await researchProspect(contact.id);
                    toast.push(
                      result.ok ? 'Research complete' : result.error,
                      result.ok ? 'success' : 'error',
                    );
                    if (result.ok) router.refresh();
                  })
                }
              >
                Run research
              </Button>
            </div>
          ) : null
        }
      >
        Details
      </SectionTitle>

      {preview ? (
        <Card className="mb-3 border-accent-600/40 bg-accent-600/5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-accent-400">
            Generated opening message
          </p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink-100">{preview.message}</p>
          {preview.rationale ? (
            <p className="mt-2 text-xs text-ink-500">{preview.rationale}</p>
          ) : null}
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="mt-2 text-xs text-ink-400 hover:text-ink-200"
          >
            Dismiss
          </button>
        </Card>
      ) : null}

      <Card>
        <ActionForm
          action={updateProspectAction}
          successMessage="Prospect saved"
          className="space-y-4"
        >
          <input type="hidden" name="id" value={contact.id} />
          <input type="hidden" name="companyId" value={company?.id ?? ''} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="firstName">
              <input id="firstName" name="firstName" defaultValue={contact.firstName ?? ''} className={inputClass} readOnly={!canWrite} />
            </Field>
            <Field label="Last name" htmlFor="lastName">
              <input id="lastName" name="lastName" defaultValue={contact.lastName ?? ''} className={inputClass} readOnly={!canWrite} />
            </Field>
            <Field label="Phone" htmlFor="phone">
              <input id="phone" name="phone" defaultValue={contact.phone} required className={inputClass} readOnly={!canWrite} />
            </Field>
            <Field label="Email" htmlFor="email">
              <input id="email" name="email" type="email" defaultValue={contact.email ?? ''} className={inputClass} readOnly={!canWrite} />
            </Field>
            <Field label="Title" htmlFor="title">
              <input id="title" name="title" defaultValue={contact.title ?? ''} className={inputClass} readOnly={!canWrite} />
            </Field>
          </div>

          {company ? (
            <>
              <div className="border-t border-ink-800 pt-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  Company
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Company name" htmlFor="companyName">
                    <input id="companyName" name="companyName" defaultValue={company.name} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Owner" htmlFor="ownerName">
                    <input id="ownerName" name="ownerName" defaultValue={company.ownerName ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Website" htmlFor="website">
                    <input id="website" name="website" defaultValue={company.website ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Industry" htmlFor="industry">
                    <input id="industry" name="industry" defaultValue={company.industry ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="City" htmlFor="city">
                    <input id="city" name="city" defaultValue={company.city ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Province / state" htmlFor="province">
                    <input id="province" name="province" defaultValue={company.province ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Google reviews" htmlFor="googleReviews">
                    <input id="googleReviews" name="googleReviews" type="number" defaultValue={company.googleReviews ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Google rating" htmlFor="googleRating">
                    <input id="googleRating" name="googleRating" type="number" step="0.1" defaultValue={company.googleRating ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Estimated size" htmlFor="estimatedCompanySize" hint="e.g. 6-10">
                    <input id="estimatedCompanySize" name="estimatedCompanySize" defaultValue={company.estimatedCompanySize ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="CRM detected" htmlFor="crmDetected" hint="Leave blank if none.">
                    <input id="crmDetected" name="crmDetected" defaultValue={company.crmDetected ?? ''} className={inputClass} readOnly={!canWrite} />
                  </Field>
                  <Field label="Website quality" htmlFor="websiteQuality">
                    <select id="websiteQuality" name="websiteQuality" defaultValue={company.websiteQuality ?? ''} className={selectClass} disabled={!canWrite}>
                      <option value="">Unknown</option>
                      <option value="strong">Strong</option>
                      <option value="adequate">Adequate</option>
                      <option value="weak">Weak</option>
                      <option value="none">No website</option>
                    </select>
                  </Field>
                  <Field
                    label="Running ads"
                    htmlFor="adPresence"
                    hint="Unknown is a real answer — it is scored as unknown, not as no."
                  >
                    <select id="adPresence" name="adPresence" defaultValue={triState(company.adPresence)} className={selectClass} disabled={!canWrite}>
                      <option value="">Unknown</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </Field>
                  <Field label="Booking system" htmlFor="bookingSystemDetected">
                    <select id="bookingSystemDetected" name="bookingSystemDetected" defaultValue={triState(company.bookingSystemDetected)} className={selectClass} disabled={!canWrite}>
                      <option value="">Unknown</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </Field>
                </div>
              </div>
            </>
          ) : null}

          {canWrite ? (
            <div className="flex justify-end border-t border-ink-800 pt-3">
              <Button type="submit" variant="primary">
                Save and rescore
              </Button>
            </div>
          ) : null}
        </ActionForm>
      </Card>
    </section>
  );
}
