/**
 * Enum values, defined once and shared by both the database schema and the UI.
 *
 * This module is deliberately dependency-free: client components import these
 * arrays, so nothing here may reach into the database, the environment, or
 * anything else that only exists on the server.
 */
export const USER_ROLES = ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER'] as const;

export const PROSPECT_STATUSES = [
  'NEW',
  'RESEARCHING',
  'READY',
  'QUEUED',
  'CONTACTED',
  'REPLIED',
  'QUALIFIED',
  'APPOINTMENT',
  'OPPORTUNITY',
  'WON',
  'LOST',
  'DO_NOT_CONTACT',
] as const;

export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;

export const CAMPAIGN_MEMBERSHIP_STATUSES = [
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
] as const;

export const CONVERSATION_STATES = [
  'NEW',
  'OPENING',
  'DISCOVERY',
  'PAIN',
  'QUALIFICATION',
  'VALUE',
  'OBJECTION',
  'APPOINTMENT',
  'BOOKED',
  'HUMAN_HANDOFF',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
  'CLOSED',
] as const;

export const MESSAGE_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;

export const MESSAGE_STATUSES = [
  'DRAFT',
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'UNDELIVERED',
  'RECEIVED',
] as const;

export const MESSAGE_AUTHORS = ['AI', 'HUMAN', 'SYSTEM', 'PROSPECT'] as const;

export const JOB_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'DEAD',
  'CANCELLED',
] as const;

export const PIPELINE_STAGES = [
  'NEW',
  'CONTACTED',
  'REPLIED',
  'QUALIFIED',
  'APPOINTMENT',
  'SHOWED',
  'OPPORTUNITY',
  'PROPOSAL',
  'WON',
  'LOST',
] as const;

export const APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'RESCHEDULED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
] as const;

export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;

export const INTENTS = [
  'positive',
  'negative',
  'neutral',
  'question',
  'opt_out',
  'wrong_number',
  'unknown',
] as const;

export const LEAD_TEMPERATURES = ['cold', 'warm', 'hot'] as const;

export const AGENT_TYPES = [
  'sales',
  'research',
  'personalization',
  'qualification',
  'summary',
  'classifier',
] as const;

export const SUPPRESSION_REASONS = [
  'OPT_OUT',
  'MANUAL',
  'INVALID_NUMBER',
  'COMPLAINT',
  'HARD_BOUNCE',
] as const;

export const ACTIVITY_TYPES = [
  'prospect_created',
  'prospect_updated',
  'prospect_imported',
  'research_completed',
  'score_changed',
  'campaign_assigned',
  'campaign_removed',
  'message_queued',
  'message_sent',
  'message_delivered',
  'message_failed',
  'inbound_received',
  'ai_response',
  'ai_failed',
  'human_response',
  'state_changed',
  'stage_changed',
  'human_handoff',
  'qualification_updated',
  'appointment_created',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_completed',
  'opportunity_created',
  'deal_won',
  'deal_lost',
  'suppressed',
  'note',
] as const;

export const NOTIFICATION_TYPES = [
  'hot_lead',
  'positive_reply',
  'human_handoff',
  'appointment_booked',
  'appointment_upcoming',
  'ai_failure',
  'provider_failure',
  'campaign_completed',
] as const;

export const PROVIDER_KINDS = ['twilio', 'telnyx', 'mock'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type MembershipStatus = (typeof CAMPAIGN_MEMBERSHIP_STATUSES)[number];
export type ConversationState = (typeof CONVERSATION_STATES)[number];
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Intent = (typeof INTENTS)[number];
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number];
export type AgentType = (typeof AGENT_TYPES)[number];
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/* ------------------------------------------------------------- UI labelling */

export const STAGE_LABELS: Record<PipelineStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUALIFIED: 'Qualified',
  APPOINTMENT: 'Appointment',
  SHOWED: 'Showed',
  OPPORTUNITY: 'Opportunity',
  PROPOSAL: 'Proposal',
  WON: 'Won',
  LOST: 'Lost',
};

/** The six opening angles the default campaign tests against each other. */
export const MESSAGE_ANGLES = [
  { key: 'lost_leads', label: 'Lost leads' },
  { key: 'old_estimates', label: 'Old estimates' },
  { key: 'speed_to_lead', label: 'Speed-to-lead' },
  { key: 'follow_up', label: 'Lead follow-up' },
  { key: 'curiosity', label: 'Curiosity' },
  { key: 'direct_offer', label: 'Direct offer' },
] as const;

/** Variables a message template may use. */
export const AVAILABLE_VARIABLES = [
  { key: 'first_name', description: "Prospect's first name, or the owner's first name" },
  { key: 'company', description: 'Company name' },
  { key: 'city', description: 'City' },
  { key: 'province', description: 'Province or state' },
  { key: 'industry', description: 'Industry' },
  { key: 'service', description: 'Their service in plain language (e.g. "roof replacements")' },
  { key: 'personalization_hook', description: 'Researched opening line specific to this business' },
  { key: 'owner_name', description: 'Owner name from research' },
  { key: 'reviews', description: 'Google review count' },
  { key: 'sender_name', description: 'Your agent name from settings' },
  { key: 'offer_name', description: 'Your product name from settings' },
] as const;

/** Every variable a template is allowed to reference, including aliases. */
export const KNOWN_TEMPLATE_VARIABLES = new Set<string>([
  'first_name',
  'last_name',
  'full_name',
  'company',
  'city',
  'province',
  'industry',
  'service',
  'personalization_hook',
  'owner_name',
  'reviews',
  'rating',
  'website',
  'sender_name',
  'offer_name',
  'company_name',
]);
