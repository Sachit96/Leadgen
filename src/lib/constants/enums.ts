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
  'discovery_started',
  'business_discovered',
  'lead_normalized',
  'duplicate_matched',
  'enrichment_started',
  'enrichment_completed',
  'signals_detected',
  'lead_approved',
  'lead_rejected',
  'call_queue_added',
  'call_queue_removed',
  'call_initiated',
  'call_outcome',
  'call_note',
  'callback_scheduled',
  'call_skipped',
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

/* ------------------------------------------------ lead generation & calling */

export const SEARCH_JOB_STATUSES = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export const LEAD_STAGES = [
  'DISCOVERED',
  'NORMALIZED',
  'DUPLICATE',
  'ENRICHING',
  'ENRICHED',
  'RESEARCHED',
  'SCORED',
  'PERSONALIZED',
  'REVIEW',
  'APPROVED',
  'REJECTED',
  'FAILED',
] as const;

export const LEAD_JOB_TYPES = [
  'lead_discovery',
  'lead_normalization',
  'lead_deduplication',
  'website_enrichment',
  'social_enrichment',
  'contact_enrichment',
  'ai_research',
  'lead_scoring',
  'personalization_generation',
  'campaign_assignment',
  'call_queue_generation',
] as const;

export const LEAD_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'DEAD',
  'SKIPPED',
  'CANCELLED',
] as const;

export const DISCOVERY_PROVIDERS = ['google_places', 'csv', 'mock'] as const;

/** How two records were judged to be the same business. */
export const DUPLICATE_REASONS = [
  'place_id',
  'phone',
  'website_domain',
  'email',
  'name_and_address',
] as const;

/**
 * Call readiness. A lead is only CALL_READY once it has a valid phone, a
 * company, an industry, a location and a score.
 */
export const CALL_READINESS = ['NOT_READY', 'READY', 'QUEUED', 'CALLED', 'CALLBACK', 'COMPLETED'] as const;

export const CALL_QUEUE_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;

export const CALL_QUEUE_ITEM_STATUSES = ['PENDING', 'CURRENT', 'COMPLETED', 'SKIPPED', 'REMOVED'] as const;

/**
 * Call outcomes.
 *
 * INITIATED is the only thing a `tel:` handoff can actually establish — the app
 * knows the operator pressed the number and nothing more. Every other value is
 * either marked by the human or supplied by a voice provider that reports it.
 */
export const CALL_OUTCOMES = [
  'INITIATED',
  'CONNECTED',
  'BOOKED',
  'NO_ANSWER',
  'CALLBACK',
  'NOT_INTERESTED',
  'WRONG_NUMBER',
  'VOICEMAIL',
  'BUSY',
  'CONNECTED_NO_INTEREST',
  'QUALIFIED',
  'FOLLOW_UP',
  'BAD_NUMBER',
  'FAILED',
  'SKIPPED',
] as const;

/** The five that are always on screen. */
export const PRIMARY_DISPOSITIONS = [
  'BOOKED',
  'NO_ANSWER',
  'CALLBACK',
  'NOT_INTERESTED',
  'WRONG_NUMBER',
] as const;

export const NOT_INTERESTED_REASONS = [
  'Already has a solution',
  'Not interested',
  'Bad timing',
  'Too expensive',
  'Wrong service',
  'Other',
] as const;

export const SKIP_REASONS = [
  'Bad timing',
  'Need research',
  'Wrong time zone',
  'Already called',
  'Other',
] as const;

export const CALL_PROVIDERS = ['device', 'twilio_voice', 'telnyx_voice'] as const;

export const NEXT_ACTIONS = ['CALL', 'CALLBACK', 'SEND_SMS', 'RESEARCH', 'BOOK', 'WAIT', 'CLOSE'] as const;

export type SearchJobStatus = (typeof SEARCH_JOB_STATUSES)[number];
export type LeadStage = (typeof LEAD_STAGES)[number];
export type LeadJobType = (typeof LEAD_JOB_TYPES)[number];
export type LeadJobStatus = (typeof LEAD_JOB_STATUSES)[number];
export type DiscoveryProviderKind = (typeof DISCOVERY_PROVIDERS)[number];
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];
export type CallReadiness = (typeof CALL_READINESS)[number];
export type CallQueueStatus = (typeof CALL_QUEUE_STATUSES)[number];
export type CallQueueItemStatus = (typeof CALL_QUEUE_ITEM_STATUSES)[number];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export type PrimaryDisposition = (typeof PRIMARY_DISPOSITIONS)[number];
export type CallProviderKind = (typeof CALL_PROVIDERS)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const DISPOSITION_LABELS: Record<PrimaryDisposition, string> = {
  BOOKED: 'Booked',
  NO_ANSWER: 'No answer',
  CALLBACK: 'Callback',
  NOT_INTERESTED: 'Not interested',
  WRONG_NUMBER: 'Wrong number',
};

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
