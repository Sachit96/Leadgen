'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PROSPECT_STATUSES } from '@/lib/constants/enums';
import { cn, selectClass } from '@/components/ui/primitives';

const SORTS = [
  { value: 'created_desc', label: 'Newest first' },
  { value: 'score_desc', label: 'Highest score' },
  { value: 'score_asc', label: 'Lowest score' },
  { value: 'activity_desc', label: 'Recent activity' },
  { value: 'next_action_asc', label: 'Next action due' },
  { value: 'company_asc', label: 'Company A–Z' },
];

const BUCKETS = ['A', 'B', 'C', 'D'];

export function ProspectFiltersBar({
  industries,
  cities,
  campaigns,
}: {
  industries: string[];
  cities: string[];
  campaigns: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    // Any filter change invalidates the current page number.
    next.delete('page');
    router.push(`/prospects?${next}`);
  };

  const toggleBucket = (bucket: string) => {
    const current = (params.get('bucket') ?? '').split(',').filter(Boolean);
    const next = current.includes(bucket)
      ? current.filter((b) => b !== bucket)
      : [...current, bucket];
    update('bucket', next.join(','));
  };

  const activeBuckets = (params.get('bucket') ?? '').split(',').filter(Boolean);
  const hasFilters = ['q', 'status', 'bucket', 'industry', 'city', 'campaign'].some((k) =>
    params.get(k),
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          update('q', query.trim() || null);
        }}
        className="min-w-56 flex-1"
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, company, phone, city…"
          aria-label="Search prospects"
          className="w-full rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-sm placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
        />
      </form>

      <select
        aria-label="Status"
        value={params.get('status') ?? ''}
        onChange={(e) => update('status', e.target.value || null)}
        className={cn(selectClass, 'w-auto')}
      >
        <option value="">All statuses</option>
        {PROSPECT_STATUSES.map((status) => (
          <option key={status} value={status}>
            {status.replace(/_/g, ' ').toLowerCase()}
          </option>
        ))}
      </select>

      <select
        aria-label="Industry"
        value={params.get('industry') ?? ''}
        onChange={(e) => update('industry', e.target.value || null)}
        className={cn(selectClass, 'w-auto')}
      >
        <option value="">All industries</option>
        {industries.map((industry) => (
          <option key={industry} value={industry}>
            {industry}
          </option>
        ))}
      </select>

      <select
        aria-label="City"
        value={params.get('city') ?? ''}
        onChange={(e) => update('city', e.target.value || null)}
        className={cn(selectClass, 'w-auto')}
      >
        <option value="">All cities</option>
        {cities.map((city) => (
          <option key={city} value={city}>
            {city}
          </option>
        ))}
      </select>

      <select
        aria-label="Campaign"
        value={params.get('campaign') ?? ''}
        onChange={(e) => update('campaign', e.target.value || null)}
        className={cn(selectClass, 'w-auto')}
      >
        <option value="">Any campaign</option>
        <option value="none">Not in a campaign</option>
        {campaigns.map((campaign) => (
          <option key={campaign.id} value={campaign.id}>
            {campaign.name}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1" role="group" aria-label="Score bucket">
        {BUCKETS.map((bucket) => (
          <button
            key={bucket}
            type="button"
            aria-pressed={activeBuckets.includes(bucket)}
            onClick={() => toggleBucket(bucket)}
            className={cn(
              'size-7 rounded border text-xs font-medium transition-colors',
              activeBuckets.includes(bucket)
                ? 'border-accent-500 bg-accent-600/20 text-accent-400'
                : 'border-ink-600 text-ink-400 hover:border-ink-500 hover:text-ink-200',
            )}
          >
            {bucket}
          </button>
        ))}
      </div>

      <select
        aria-label="Sort"
        value={params.get('sort') ?? 'created_desc'}
        onChange={(e) => update('sort', e.target.value)}
        className={cn(selectClass, 'w-auto')}
      >
        {SORTS.map((sort) => (
          <option key={sort.value} value={sort.value}>
            {sort.label}
          </option>
        ))}
      </select>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => router.push('/prospects')}
          className="text-xs text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
