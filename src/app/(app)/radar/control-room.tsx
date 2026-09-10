'use client';

import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowUpRight,
  Banknote,
  BarChart3,
  Brain,
  Calendar,
  ClipboardCheck,
  KanbanSquare,
  Layers,
  MessageSquare,
  Radar,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { RadarIcon, RadarSnapshot, RadarStage } from '@/lib/services/radar';
import { Ambient } from './ambient';

/** The one easing curve the whole screen moves on. */
const EASE = [0.22, 1, 0.36, 1] as const;

const ICONS: Record<RadarIcon, LucideIcon> = {
  radar: Radar,
  layers: Layers,
  brain: Brain,
  clipboard: ClipboardCheck,
  message: MessageSquare,
  sparkles: Sparkles,
  calendar: Calendar,
  kanban: KanbanSquare,
  banknote: Banknote,
  chart: BarChart3,
};

/** Where each stage lives in the app, so the dashboard is a way in. */
const DESTINATIONS: Record<string, string> = {
  lead_generation: '/lead-generation',
  enrichment: '/lead-generation/leads?view=ENRICHED',
  intelligence: '/lead-generation/leads?view=ENRICHED',
  review: '/lead-generation/leads?view=REVIEW',
  sms: '/inbox',
  qualification: '/inbox?filter=hot',
  appointment: '/calendar',
  pipeline: '/pipeline',
  revenue: '/analytics',
  analytics: '/analytics',
};

const RANGES = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];

const MICRO = 'text-[11px] tracking-[0.2em] text-white/45 uppercase';
const PANEL = 'rounded-2xl border border-white/10 bg-[#0a0a0a]/80 backdrop-blur-xl';
const BRAND = 'bg-gradient-to-br from-[#9C35F0] to-[#ec4899]';

export function ControlRoom({ snapshot, preset }: { snapshot: RadarSnapshot; preset: string }) {
  const reduce = useReducedMotion();

  // Entrances cascade; with reduced motion they simply appear in place.
  const rise = (index: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 24 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, delay: 0.05 + index * 0.045, ease: EASE },
        };

  return (
    <div className="relative min-h-full overflow-hidden bg-black">
      <Ambient />

      <div className="relative z-10 mx-auto max-w-[1400px] px-6 py-10 lg:px-10">
        <Header snapshot={snapshot} preset={preset} rise={rise} />

        <div className="mt-10 space-y-10">
          {snapshot.groups.map((group, groupIndex) => (
            <StageGroup
              key={group}
              group={group}
              stages={snapshot.stages.filter((stage) => stage.group === group)}
              index={groupIndex}
              rise={rise}
            />
          ))}
        </div>

        <motion.div {...rise(12)} className="mt-10 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <FlowRail stages={snapshot.stages} />
          <SmsThread thread={snapshot.thread} />
        </motion.div>

        <motion.p {...rise(14)} className={`mt-10 ${MICRO}`}>
          Every figure read from the database · {snapshot.range.label}
        </motion.p>
      </div>
    </div>
  );
}

type Rise = (index: number) => Record<string, unknown>;

function Header({ snapshot, preset, rise }: { snapshot: RadarSnapshot; preset: string; rise: Rise }) {
  const { headline } = snapshot;

  return (
    <header>
      <motion.div {...rise(0)} className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className={MICRO}>On Radar · Control Room</p>
          <h1 className="mt-3 font-clash text-4xl font-semibold leading-tight tracking-[-0.03em] text-white sm:text-5xl">
            Lead conversion pipeline
          </h1>
          <p className="mt-3 max-w-xl font-inter text-white/80">
            Ten stages from a market search to booked revenue. Each panel counts rows the pipeline
            wrote — a stage that has not run reads zero rather than an estimate.
          </p>
        </div>

        <nav aria-label="Date range" className="flex flex-wrap gap-1.5">
          {RANGES.map((range) => {
            const active = range.value === preset;
            return (
              <Link
                key={range.value}
                href={`/radar?range=${range.value}`}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? `rounded-full ${BRAND} px-4 py-2 font-inter text-[13px] font-medium text-white shadow-[0_0_30px_-6px_rgba(156,53,240,0.7)]`
                    : 'rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 font-inter text-[13px] text-white/70 transition-colors hover:border-white/20 hover:text-white'
                }
              >
                {range.label}
              </Link>
            );
          })}
        </nav>
      </motion.div>

      <motion.div {...rise(1)} className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Headline label="Businesses discovered" value={headline.discovered.toLocaleString()} />
        <Headline
          label="Signals with evidence"
          value={headline.signals.toLocaleString()}
        />
        <Headline
          label="Contacted → won"
          value={`${headline.conversion}%`}
          accent={headline.conversion > 0}
        />
        <Headline
          label="Revenue booked"
          value={snapshot.stages.find((s) => s.key === 'revenue')?.display ?? '—'}
          accent={headline.revenueCents > 0}
        />
      </motion.div>
    </header>
  );
}

function Headline({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`${PANEL} p-5`}>
      <p className={MICRO}>{label}</p>
      <p
        className={
          accent
            ? 'mt-3 bg-gradient-to-br from-[#9C35F0] to-[#ec4899] bg-clip-text font-clash text-3xl font-semibold tracking-[-0.03em] text-transparent'
            : 'mt-3 font-clash text-3xl font-semibold tracking-[-0.03em] text-white'
        }
      >
        {value}
      </p>
    </div>
  );
}

function StageGroup({
  group,
  stages,
  index,
  rise,
}: {
  group: string;
  stages: RadarStage[];
  index: number;
  rise: Rise;
}) {
  return (
    <section>
      <motion.div {...rise(2 + index)} className="mb-4 flex items-center gap-4">
        <h2 className={MICRO}>{group}</h2>
        <span className="h-px flex-1 bg-gradient-to-r from-white/15 to-transparent" />
        <span className="font-inter text-[13px] text-white/45">
          {stages.map((stage) => stage.label).join(' → ')}
        </span>
      </motion.div>

      <div className="grid items-stretch gap-4 md:grid-cols-2">
        {stages.map((stage, stageIndex) => (
          <StageCard key={stage.key} stage={stage} index={index * 2 + stageIndex} rise={rise} />
        ))}
      </div>
    </section>
  );
}

function StageCard({ stage, index, rise }: { stage: RadarStage; index: number; rise: Rise }) {
  const Icon = ICONS[stage.icon];
  const href = DESTINATIONS[stage.key] ?? '/analytics';
  const empty = stage.value === 0;

  return (
    <motion.div {...rise(3 + index)} className="h-full">
      <Link
        href={href}
        className={`group relative flex h-full flex-col overflow-hidden ${PANEL} p-6 transition-colors hover:border-white/20`}
      >
        {/* The brand wash, revealed on hover rather than always burning. */}
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-[0.07] ${BRAND}`}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full bg-gradient-to-br from-[#9C35F0]/25 to-[#ec4899]/25 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
        />

        <div className="relative flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={
                empty
                  ? 'grid size-10 place-items-center rounded-xl border border-white/10 bg-white/[0.03]'
                  : `grid size-10 place-items-center rounded-xl ${BRAND} shadow-[0_0_28px_-8px_rgba(156,53,240,0.9)]`
              }
            >
              <Icon strokeWidth={1.25} className={empty ? 'size-5 text-white/40' : 'size-5 text-white'} />
            </span>
            <div>
              <p className="font-clash text-lg font-semibold leading-tight tracking-[-0.03em] text-white">
                {stage.label}
              </p>
              <p className={`mt-1 ${MICRO}`}>{stage.group}</p>
            </div>
          </div>

          <ArrowUpRight
            strokeWidth={1.25}
            className="size-4 shrink-0 text-white/25 transition-colors group-hover:text-white/70"
          />
        </div>

        <p className="relative mt-6 font-clash text-4xl font-semibold leading-tight tracking-[-0.03em] text-white tabular-nums">
          {stage.display}
        </p>
        <p className="relative mt-2 font-inter text-[13px] leading-relaxed text-white/80">{stage.detail}</p>

        {/* Pushes the rate to the bottom, so rows line up whether or not a
            stage has a denominator to report against. */}
        <div className="mt-auto">
          {stage.flow !== null ? <FlowBar flow={stage.flow} label={stage.flowOf} /> : null}
        </div>
      </Link>
    </motion.div>
  );
}

/** Conversion from the previous stage, drawn rather than only stated. */
function FlowBar({ flow, label }: { flow: number; label: string | null }) {
  const reduce = useReducedMotion();
  const width = Math.max(2, Math.min(100, flow));

  return (
    <div className="relative mt-5">
      <div className="flex items-center justify-between gap-3">
        <span className={MICRO}>{label ?? 'Converted'}</span>
        <span className="font-inter text-[13px] font-medium tabular-nums text-white">{flow}%</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className={`h-full rounded-full ${BRAND}`}
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 1.1, delay: 0.35, ease: EASE }}
        />
      </div>
    </div>
  );
}

/** The whole run as one rail, so the drop-off is visible at a glance. */
function FlowRail({ stages }: { stages: RadarStage[] }) {
  const reduce = useReducedMotion();
  const peak = Math.max(...stages.slice(0, 8).map((stage) => stage.value), 1);

  return (
    <div className={`${PANEL} p-6`}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-clash text-lg font-semibold tracking-[-0.03em] text-white">Throughput</h2>
        <p className={MICRO}>Discovery → pipeline</p>
      </div>

      <ol className="mt-6 space-y-3">
        {stages.slice(0, 8).map((stage, index) => {
          const Icon = ICONS[stage.icon];
          const width = Math.max(1.5, (stage.value / peak) * 100);
          return (
            <li key={stage.key} className="flex items-center gap-3">
              <Icon strokeWidth={1.25} className="size-4 shrink-0 text-white/35" />
              <span className="w-32 shrink-0 truncate font-inter text-[13px] text-white/80">
                {stage.label}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <motion.div
                  className={`h-full rounded-full ${BRAND}`}
                  initial={reduce ? false : { width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ duration: 0.9, delay: 0.2 + index * 0.06, ease: EASE }}
                />
              </div>
              <span className="w-16 shrink-0 text-right font-inter text-[13px] tabular-nums text-white">
                {stage.value.toLocaleString()}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The SMS stage, rendered as live DOM.
 *
 * Real messages from the most recently active conversation — no image assets and
 * no invented transcript. Outbound turns carry the brand gradient; the lead's
 * replies sit in glass.
 */
function SmsThread({ thread }: { thread: RadarSnapshot['thread'] }) {
  const reduce = useReducedMotion();

  return (
    <div className={`${PANEL} flex flex-col p-6`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-clash text-lg font-semibold tracking-[-0.03em] text-white">Live thread</h2>
          <p className={`mt-1 ${MICRO}`}>
            {thread ? (thread.companyName ?? 'Unnamed business') : 'No conversations yet'}
          </p>
        </div>
        {thread ? (
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-inter text-[11px] text-white/70">
            {thread.state.toLowerCase().replace(/_/g, ' ')}
          </span>
        ) : null}
      </div>

      {!thread || thread.turns.length === 0 ? (
        <div className="mt-8 flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/10 px-6 py-12 text-center">
          <p className="font-inter text-[13px] text-white/45">
            Nothing has been sent yet. Approved leads enrolled in a campaign start a thread here.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {thread.turns.map((turn, index) => {
            const outbound = turn.direction === 'OUTBOUND';
            return (
              <motion.div
                key={turn.id}
                initial={reduce ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.4 + index * 0.09, ease: EASE }}
                className={outbound ? 'flex justify-end' : 'flex justify-start'}
              >
                <div className="max-w-[85%]">
                  <div
                    className={
                      outbound
                        ? `rounded-2xl rounded-br-md ${BRAND} px-4 py-2.5 font-inter text-[13px] leading-relaxed text-white shadow-[0_0_36px_-10px_rgba(236,72,153,0.85)]`
                        : 'rounded-2xl rounded-bl-md border border-white/10 bg-white/5 px-4 py-2.5 font-inter text-[13px] leading-relaxed text-white/80 backdrop-blur-md'
                    }
                  >
                    {turn.body}
                  </div>
                  <p className={`mt-1.5 ${MICRO} ${outbound ? 'text-right' : ''}`}>
                    {outbound ? (turn.author === 'HUMAN' ? 'Operator' : 'AI') : 'Lead'}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
