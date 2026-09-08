'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { cn, inputClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];

export function RangePicker({ current }: { current: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [custom, setCustom] = useState(false);

  const apply = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('range', value);
    next.delete('from');
    next.delete('to');
    router.push(`/analytics?${next}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESETS.map((preset) => (
        <button
          key={preset.value}
          type="button"
          aria-pressed={current === preset.value}
          onClick={() => apply(preset.value)}
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors',
            current === preset.value
              ? 'bg-accent-600 font-medium text-white'
              : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200',
          )}
        >
          {preset.label}
        </button>
      ))}

      <button
        type="button"
        onClick={() => setCustom((v) => !v)}
        className="rounded px-2 py-1 text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-200"
      >
        Custom
      </button>

      {custom ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const next = new URLSearchParams();
            next.set('from', String(form.get('from') ?? ''));
            next.set('to', String(form.get('to') ?? ''));
            router.push(`/analytics?${next}`);
          }}
        >
          <input type="date" name="from" required aria-label="From" className={cn(inputClass, 'w-auto py-1')} />
          <input type="date" name="to" aria-label="To" className={cn(inputClass, 'w-auto py-1')} />
          <Button type="submit" size="sm">
            Apply
          </Button>
        </form>
      ) : null}
    </div>
  );
}
