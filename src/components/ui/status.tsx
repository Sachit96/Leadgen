import { Badge, type Tone } from './primitives';
import type {
  CampaignStatus,
  ConversationState,
  LeadTemperature,
  MessageStatus,
  PipelineStage,
  ProspectStatus,
} from '@/lib/constants/enums';

/**
 * One place decides what each status looks like, so a prospect that is QUALIFIED
 * reads identically on every screen.
 */
const PROSPECT_TONES: Record<ProspectStatus, Tone> = {
  NEW: 'neutral',
  RESEARCHING: 'neutral',
  READY: 'accent',
  QUEUED: 'accent',
  CONTACTED: 'accent',
  REPLIED: 'positive',
  QUALIFIED: 'positive',
  APPOINTMENT: 'hot',
  OPPORTUNITY: 'hot',
  WON: 'positive',
  LOST: 'neutral',
  DO_NOT_CONTACT: 'danger',
};

const PROSPECT_LABELS: Record<ProspectStatus, string> = {
  NEW: 'New',
  RESEARCHING: 'Researching',
  READY: 'Ready',
  QUEUED: 'Queued',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUALIFIED: 'Qualified',
  APPOINTMENT: 'Appointment',
  OPPORTUNITY: 'Opportunity',
  WON: 'Won',
  LOST: 'Lost',
  DO_NOT_CONTACT: 'Do not contact',
};

export function ProspectStatusBadge({ status }: { status: ProspectStatus }) {
  return <Badge tone={PROSPECT_TONES[status]}>{PROSPECT_LABELS[status]}</Badge>;
}

const STATE_TONES: Record<ConversationState, Tone> = {
  NEW: 'neutral',
  OPENING: 'accent',
  DISCOVERY: 'accent',
  PAIN: 'accent',
  QUALIFICATION: 'positive',
  VALUE: 'positive',
  OBJECTION: 'warning',
  APPOINTMENT: 'hot',
  BOOKED: 'hot',
  HUMAN_HANDOFF: 'warning',
  NOT_INTERESTED: 'neutral',
  DO_NOT_CONTACT: 'danger',
  CLOSED: 'neutral',
};

export function ConversationStateBadge({ state }: { state: ConversationState }) {
  return <Badge tone={STATE_TONES[state]}>{state.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function TemperatureBadge({ temperature }: { temperature: LeadTemperature }) {
  const tone: Record<LeadTemperature, Tone> = { cold: 'neutral', warm: 'warning', hot: 'hot' };
  return <Badge tone={tone[temperature]}>{temperature}</Badge>;
}

export function ScoreBadge({ score, bucket }: { score: number | null; bucket: string | null }) {
  if (score === null) return <span className="text-xs text-ink-500">—</span>;
  const tone: Tone = bucket === 'A' ? 'positive' : bucket === 'B' ? 'accent' : bucket === 'C' ? 'warning' : 'neutral';
  return (
    <Badge tone={tone} className="tabular-nums">
      {bucket ?? '?'} · {score}
    </Badge>
  );
}

const CAMPAIGN_TONES: Record<CampaignStatus, Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'positive',
  PAUSED: 'warning',
  COMPLETED: 'accent',
  ARCHIVED: 'neutral',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge tone={CAMPAIGN_TONES[status]}>{status.toLowerCase()}</Badge>;
}

const MESSAGE_TONES: Record<MessageStatus, Tone> = {
  DRAFT: 'neutral',
  QUEUED: 'neutral',
  SENDING: 'accent',
  SENT: 'accent',
  DELIVERED: 'positive',
  RECEIVED: 'positive',
  UNDELIVERED: 'danger',
  FAILED: 'danger',
};

export function MessageStatusLabel({ status }: { status: MessageStatus }) {
  const tone = MESSAGE_TONES[status];
  const color =
    tone === 'positive'
      ? 'text-positive-400'
      : tone === 'danger'
        ? 'text-danger-400'
        : tone === 'accent'
          ? 'text-accent-400'
          : 'text-ink-500';
  return <span className={`text-[10px] uppercase tracking-wide ${color}`}>{status.toLowerCase()}</span>;
}

export const STAGE_TONES: Record<PipelineStage, Tone> = {
  NEW: 'neutral',
  CONTACTED: 'accent',
  REPLIED: 'accent',
  QUALIFIED: 'positive',
  APPOINTMENT: 'hot',
  SHOWED: 'hot',
  OPPORTUNITY: 'hot',
  PROPOSAL: 'warning',
  WON: 'positive',
  LOST: 'neutral',
};
