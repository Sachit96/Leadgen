import { cn } from './primitives';

/**
 * Inline SVG charts.
 *
 * Small enough to hand-build, which avoids shipping a charting library for
 * three chart types — and keeps them theme-aware and accessible by default:
 * every chart carries a text alternative and a readable axis.
 */
export type SeriesPoint = { label: string; values: Record<string, number> };

const SERIES_COLORS: Record<string, string> = {
  sent: 'var(--color-accent-500)',
  delivered: 'var(--color-accent-400)',
  replies: 'var(--color-positive-500)',
  appointments: 'var(--color-hot-500)',
};

export function LineChart({
  points,
  series,
  height = 180,
  title,
}: {
  points: SeriesPoint[];
  series: Array<{ key: string; label: string }>;
  height?: number;
  title: string;
}) {
  if (points.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-500">No data in this range.</p>;
  }

  const width = 800;
  const padding = { top: 10, right: 10, bottom: 22, left: 30 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const max = Math.max(
    1,
    ...points.flatMap((point) => series.map((s) => point.values[s.key] ?? 0)),
  );

  const x = (index: number) =>
    padding.left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value: number) => padding.top + innerHeight - (value / max) * innerHeight;

  const ticks = [0, Math.round(max / 2), max];
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${title}. ${series
          .map((s) => `${s.label} peaks at ${Math.max(...points.map((p) => p.values[s.key] ?? 0))}`)
          .join('. ')}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-ink-800)"
              strokeWidth={1}
            />
            <text
              x={padding.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--color-ink-500)"
            >
              {tick}
            </text>
          </g>
        ))}

        {series.map((s) => {
          const path = points
            .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(point.values[s.key] ?? 0)}`)
            .join(' ');
          return (
            <path
              key={s.key}
              d={path}
              fill="none"
              stroke={SERIES_COLORS[s.key] ?? 'var(--color-ink-400)'}
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {points.map((point, index) =>
          index % labelEvery === 0 ? (
            <text
              key={point.label}
              x={x(index)}
              y={height - 6}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-ink-500)"
            >
              {point.label.slice(5)}
            </text>
          ) : null,
        )}
      </svg>

      <figcaption className="mt-2 flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-ink-400">
            <span
              className="inline-block h-0.5 w-3 rounded"
              style={{ background: SERIES_COLORS[s.key] ?? 'var(--color-ink-400)' }}
            />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/**
 * A funnel drawn as proportional bars, with each stage's conversion from the
 * previous one spelled out — the drop-off is the whole point.
 */
export function FunnelChart({
  stages,
}: {
  stages: Array<{ label: string; value: number; rate?: number; rateLabel?: string }>;
}) {
  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <ol className="space-y-2.5">
      {stages.map((stage, index) => {
        const width = Math.max(2, (stage.value / max) * 100);
        const previous = stages[index - 1];
        const conversion =
          stage.rate ??
          (previous && previous.value > 0
            ? Math.round((stage.value / previous.value) * 1000) / 10
            : null);

        return (
          <li key={stage.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-ink-300">{stage.label}</span>
              <span className="text-sm font-medium tabular-nums text-ink-100">
                {stage.value.toLocaleString()}
                {conversion !== null && index > 0 ? (
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    {conversion}% {stage.rateLabel ?? 'of previous'}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded bg-ink-800">
              <div
                className={cn(
                  'h-full rounded',
                  index === 0
                    ? 'bg-ink-500'
                    : index < 3
                      ? 'bg-accent-500'
                      : index < 5
                        ? 'bg-positive-500'
                        : 'bg-hot-500',
                )}
                style={{ width: `${width}%` }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function BarChart({
  bars,
  valueFormat = (v: number) => v.toLocaleString(),
}: {
  bars: Array<{ label: string; value: number; sublabel?: string }>;
  valueFormat?: (value: number) => string;
}) {
  if (bars.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-500">Nothing to compare yet.</p>;
  }
  const max = Math.max(1, ...bars.map((b) => b.value));

  return (
    <ul className="space-y-2">
      {bars.map((bar) => (
        <li key={bar.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm text-ink-300">{bar.label}</span>
            <span className="shrink-0 text-sm font-medium tabular-nums text-ink-100">
              {valueFormat(bar.value)}
              {bar.sublabel ? (
                <span className="ml-1.5 text-xs font-normal text-ink-500">{bar.sublabel}</span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full bg-accent-500"
              style={{ width: `${Math.max(1, (bar.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
