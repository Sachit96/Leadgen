'use client';

import { useRouter } from 'next/navigation';
import { ActionForm } from '@/components/ui/action-form';
import { Button } from '@/components/ui/buttons';
import { Field, inputClass, selectClass } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { createCallQueueAction } from '@/app/actions/calls';

/** Matches the scoring config's default bucket labels. */
const BUCKETS = [
  { value: 'A', label: 'A — 80 and above' },
  { value: 'B', label: 'B — 60 to 79' },
  { value: 'C', label: 'C — 40 to 59' },
  { value: 'D', label: 'D — under 40' },
];

/**
 * Builds a call queue from filters.
 *
 * The queue is materialised at creation time, so its order and its "N of M"
 * survive a reload. Only leads that pass the readiness gate — valid number,
 * company, industry, location, score — can enter it, which is why the count of
 * call-ready leads is shown next to the button.
 */
export function QueueForm({
  industries,
  cities,
  callReady,
  canWrite,
}: {
  industries: string[];
  cities: string[];
  callReady: number;
  canWrite: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  return (
    <ActionForm
      action={createCallQueueAction}
      className="space-y-3"
      onSuccess={(data: { id: string; total: number }) => {
        if (data.total === 0) {
          toast.push('Queue created, but no lead matched those filters. Widen them and rebuild.', 'error');
          router.refresh();
          return;
        }
        toast.push(`Queue built with ${data.total} leads`, 'success');
        router.push(`/calls/${data.id}`);
      }}
    >
      <Field label="Queue name" htmlFor="name">
        <input
          id="name"
          name="name"
          required
          placeholder="Mississauga roofers — Tuesday"
          className={inputClass}
        />
      </Field>

      <Field label="Note" htmlFor="description" hint="Optional — what this list is for">
        <input id="description" name="description" className={inputClass} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Min score" htmlFor="minScore">
          <input id="minScore" name="minScore" type="number" min={0} max={100} className={inputClass} />
        </Field>
        <Field label="Max leads" htmlFor="limit">
          <input id="limit" name="limit" type="number" min={1} max={1000} defaultValue={200} className={inputClass} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Industry" htmlFor="industry">
          <select id="industry" name="industry" className={selectClass} defaultValue="">
            <option value="">Any</option>
            {industries.map((i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </Field>
        <Field label="City" htmlFor="city">
          <select id="city" name="city" className={selectClass} defaultValue="">
            <option value="">Any</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Score bucket" htmlFor="bucket">
          <select id="bucket" name="bucket" className={selectClass} defaultValue="">
            <option value="">Any</option>
            {BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Min reviews" htmlFor="minReviews">
          <input id="minReviews" name="minReviews" type="number" min={0} className={inputClass} />
        </Field>
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input
            type="checkbox"
            name="notCalled"
            defaultChecked
            className="size-3.5 rounded border-ink-600 bg-ink-900 accent-accent-600"
          />
          Only leads nobody has called yet
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input
            type="checkbox"
            name="requirePersonalization"
            className="size-3.5 rounded border-ink-600 bg-ink-900 accent-accent-600"
          />
          Only leads with an opening line ready
        </label>
      </div>

      <Button type="submit" variant="primary" className="w-full" disabled={!canWrite || callReady === 0}>
        {callReady === 0 ? 'No call-ready leads yet' : `Build queue from ${callReady} call-ready leads`}
      </Button>
    </ActionForm>
  );
}
