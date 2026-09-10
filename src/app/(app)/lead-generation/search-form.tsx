'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionForm } from '@/components/ui/action-form';
import { Button } from '@/components/ui/buttons';
import { Field, inputClass, selectClass } from '@/components/ui/primitives';
import { saveSearchAction, startLeadSearchAction } from '@/app/actions/lead-generation';

export type SavedSearchOption = {
  id: string;
  name: string;
  query: string;
  location: string;
  radiusMeters: number;
};

const RADII = [
  { value: 5_000, label: '5 km' },
  { value: 10_000, label: '10 km' },
  { value: 25_000, label: '25 km' },
  { value: 50_000, label: '50 km' },
];

/**
 * The search form.
 *
 * The count and radius are on the form rather than hidden defaults because a
 * live provider bills per request — the operator should see the size of what
 * they are about to run.
 */
export function SearchForm({
  savedSearches,
  canRun,
}: {
  savedSearches: SavedSearchOption[];
  canRun: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [radius, setRadius] = useState(25_000);
  const [count, setCount] = useState(100);

  function applySaved(id: string) {
    const saved = savedSearches.find((s) => s.id === id);
    if (!saved) return;
    setQuery(saved.query);
    setLocation(saved.location);
    setRadius(saved.radiusMeters);
  }

  return (
    <div className="space-y-3">
      {savedSearches.length > 0 ? (
        <Field label="Saved search" htmlFor="saved">
          <select
            id="saved"
            className={selectClass}
            defaultValue=""
            onChange={(event) => applySaved(event.target.value)}
          >
            <option value="">Start from scratch</option>
            {savedSearches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <ActionForm
        action={startLeadSearchAction}
        successMessage="Search started — results arrive as the worker processes them"
        className="space-y-3"
        onSuccess={() => router.push('/lead-generation/leads')}
      >
        <Field label="Industry or keyword" htmlFor="query">
          <input
            id="query"
            name="query"
            required
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="roofing contractor"
            className={inputClass}
          />
        </Field>

        <Field
          label="Keywords"
          htmlFor="keywords"
          hint="Optional — narrows the search, e.g. 'flat roof commercial'"
        >
          <input id="keywords" name="keywords" placeholder="flat roof, commercial" className={inputClass} />
        </Field>

        <Field label="Location" htmlFor="location" hint="City and province, or a full address">
          <input
            id="location"
            name="location"
            required
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Mississauga, ON"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Radius" htmlFor="radiusMeters">
            <select
              id="radiusMeters"
              name="radiusMeters"
              className={selectClass}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
            >
              {RADII.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="How many" htmlFor="requestedCount" hint="Ceiling, not a promise">
            <input
              id="requestedCount"
              name="requestedCount"
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>

        <fieldset className="rounded-md border border-ink-700 p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Filters
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min reviews" htmlFor="minReviews">
              <input id="minReviews" name="minReviews" type="number" min={0} className={inputClass} />
            </Field>
            <Field label="Min rating" htmlFor="minRating">
              <input id="minRating" name="minRating" type="number" min={0} max={5} step={0.1} className={inputClass} />
            </Field>
          </div>
          <div className="mt-2">
            <Field
              label="Minimum lead score"
              htmlFor="minScore"
              hint="Leads below this are still created, but not marked for review"
            >
              <input id="minScore" name="minScore" type="number" min={0} max={100} className={inputClass} />
            </Field>
          </div>
          <div className="mt-2 space-y-1.5">
            <Check name="requirePhone" label="Must have a phone number" defaultChecked />
            <Check name="requireWebsite" label="Must have a website" />
            <Check name="excludeChains" label="Exclude franchises and chains" />
          </div>
        </fieldset>

        <Button type="submit" variant="primary" className="w-full" disabled={!canRun}>
          Run search
        </Button>
      </ActionForm>

      <ActionForm action={saveSearchAction} successMessage="Search saved" className="flex gap-2">
        <input type="hidden" name="query" value={query} />
        <input type="hidden" name="location" value={location} />
        <input type="hidden" name="radiusMeters" value={radius} />
        <input
          name="name"
          placeholder="Save this search as…"
          className={`${inputClass} flex-1`}
          required
        />
        <Button type="submit" variant="secondary" disabled={!canRun || !query || !location}>
          Save
        </Button>
      </ActionForm>
    </div>
  );
}

function Check({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink-300">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="size-3.5 rounded border-ink-600 bg-ink-900 accent-accent-600"
      />
      {label}
    </label>
  );
}
