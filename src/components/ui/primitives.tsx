import type { ReactNode } from 'react';

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ layout */

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-ink-700 bg-ink-850',
        padded && 'p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-100">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">{children}</h2>
      {action}
    </div>
  );
}

/**
 * Empty states carry the next action, not just an apology. A blank screen with
 * nothing to click is where operators get stuck.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-700 px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-ink-500">{icon}</div> : null}
      <p className="text-sm font-medium text-ink-200">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-ink-400">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ badges */

export type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' | 'hot';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-ink-600 bg-ink-750 text-ink-300',
  accent: 'border-accent-600/40 bg-accent-600/15 text-accent-400',
  positive: 'border-positive-500/40 bg-positive-500/15 text-positive-400',
  warning: 'border-warning-500/40 bg-warning-500/15 text-warning-400',
  danger: 'border-danger-500/40 bg-danger-500/15 text-danger-400',
  hot: 'border-hot-500/40 bg-hot-500/15 text-hot-500',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral' }: { tone?: Tone }) {
  const colors: Record<Tone, string> = {
    neutral: 'bg-ink-500',
    accent: 'bg-accent-500',
    positive: 'bg-positive-500',
    warning: 'bg-warning-500',
    danger: 'bg-danger-500',
    hot: 'bg-hot-500',
  };
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', colors[tone])} />;
}

/* ------------------------------------------------------------------ tables */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-700">
      <table className={cn('w-full min-w-[900px] border-collapse text-sm', className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      scope="col"
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-ink-700 bg-ink-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <td
      className={cn(
        'border-b border-ink-800 px-3 py-2 align-middle text-ink-200',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------- stats */

export function Stat({
  label,
  value,
  sublabel,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: Tone;
  href?: string;
}) {
  const valueTone: Record<Tone, string> = {
    neutral: 'text-ink-100',
    accent: 'text-accent-400',
    positive: 'text-positive-400',
    warning: 'text-warning-400',
    danger: 'text-danger-400',
    hot: 'text-hot-500',
  };

  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{label}</p>
      <p className={cn('mt-1.5 text-2xl font-semibold tabular-nums tracking-tight', valueTone[tone])}>
        {value}
      </p>
      {sublabel ? <p className="mt-0.5 text-xs text-ink-500">{sublabel}</p> : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block rounded-lg border border-ink-700 bg-ink-850 p-4 transition-colors hover:border-ink-600 hover:bg-ink-800"
      >
        {body}
      </a>
    );
  }

  return <div className="rounded-lg border border-ink-700 bg-ink-850 p-4">{body}</div>;
}

/** A labelled proportion bar — used for funnel and completeness readouts. */
export function Meter({
  label,
  value,
  max,
  tone = 'accent',
  caption,
}: {
  label: string;
  value: number;
  max: number;
  tone?: Tone;
  caption?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar: Record<Tone, string> = {
    neutral: 'bg-ink-500',
    accent: 'bg-accent-500',
    positive: 'bg-positive-500',
    warning: 'bg-warning-500',
    danger: 'bg-danger-500',
    hot: 'bg-hot-500',
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-ink-300">{label}</span>
        <span className="text-sm font-medium tabular-nums text-ink-100">
          {value.toLocaleString()}
          {caption ? <span className="ml-1.5 text-xs font-normal text-ink-500">{caption}</span> : null}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-750">
        <div className={cn('h-full rounded-full', bar[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-300">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  'w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500';

export const selectClass = `${inputClass} appearance-none pr-8`;

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-ink-500">{label}</dt>
      <dd className="truncate text-right text-xs text-ink-200">{value ?? '—'}</dd>
    </div>
  );
}
