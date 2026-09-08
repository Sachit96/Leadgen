/**
 * On Radar — database schema.
 *
 * Design rules:
 *  - Every organization-owned row carries `organizationId`. Tenant isolation is
 *    enforced in the service layer (see `src/lib/auth/context.ts`) and, for
 *    Supabase deployments, by the RLS policies in `drizzle/rls.sql`.
 *  - Event-shaped tables (activities, messageEvents, auditLogs, aiRuns) are
 *    append-only. Nothing in the service layer updates or deletes them.
 *  - Money is stored in cents as integers. Never floats.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ enums */

export const userRoleEnum = pgEnum('user_role', ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER']);

export const prospectStatusEnum = pgEnum('prospect_status', [
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
]);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
]);

export const membershipStatusEnum = pgEnum('campaign_membership_status', [
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
]);

export const conversationStateEnum = pgEnum('conversation_state', [
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
]);

export const messageDirectionEnum = pgEnum('message_direction', ['INBOUND', 'OUTBOUND']);

export const messageStatusEnum = pgEnum('message_status', [
  'DRAFT',
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'UNDELIVERED',
  'RECEIVED',
]);

export const messageAuthorEnum = pgEnum('message_author', ['AI', 'HUMAN', 'SYSTEM', 'PROSPECT']);

export const jobStatusEnum = pgEnum('job_status', [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'DEAD',
  'CANCELLED',
]);

export const pipelineStageEnum = pgEnum('pipeline_stage', [
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
]);

export const appointmentStatusEnum = pgEnum('appointment_status', [
  'SCHEDULED',
  'RESCHEDULED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
]);

export const taskStatusEnum = pgEnum('task_status', ['OPEN', 'DONE', 'CANCELLED']);

export const intentEnum = pgEnum('intent', [
  'positive',
  'negative',
  'neutral',
  'question',
  'opt_out',
  'wrong_number',
  'unknown',
]);

export const leadTemperatureEnum = pgEnum('lead_temperature', ['cold', 'warm', 'hot']);

export const agentTypeEnum = pgEnum('agent_type', [
  'sales',
  'research',
  'personalization',
  'qualification',
  'summary',
  'classifier',
]);

export const suppressionReasonEnum = pgEnum('suppression_reason', [
  'OPT_OUT',
  'MANUAL',
  'INVALID_NUMBER',
  'COMPLAINT',
  'HARD_BOUNCE',
]);

export const activityTypeEnum = pgEnum('activity_type', [
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
]);

export const notificationTypeEnum = pgEnum('notification_type', [
  'hot_lead',
  'positive_reply',
  'human_handoff',
  'appointment_booked',
  'appointment_upcoming',
  'ai_failure',
  'provider_failure',
  'campaign_completed',
]);

export const providerKindEnum = pgEnum('provider_kind', ['twilio', 'telnyx', 'mock']);

/* ------------------------------------------------------- tenancy & identity */

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('America/Toronto'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull().default('SALES_REP'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('memberships_org_user_unique').on(t.organizationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Free-form org settings: offer/pricing, scoring weights, sending defaults. */
export const orgSettings = pgTable('org_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  offer: jsonb('offer').notNull().default(sql`'{}'::jsonb`),
  scoring: jsonb('scoring').notNull().default(sql`'{}'::jsonb`),
  sending: jsonb('sending').notNull().default(sql`'{}'::jsonb`),
  ai: jsonb('ai').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------- prospect data */

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    website: text('website'),
    industry: text('industry'),
    subIndustry: text('sub_industry'),
    city: text('city'),
    province: text('province'),
    country: text('country').default('Canada'),
    googleReviews: integer('google_reviews'),
    googleRating: real('google_rating'),
    facebookUrl: text('facebook_url'),
    instagramUrl: text('instagram_url'),
    linkedinUrl: text('linkedin_url'),
    /** 'strong' | 'adequate' | 'weak' | 'none' | null when unknown. */
    websiteQuality: text('website_quality'),
    adPresence: boolean('ad_presence'),
    leadGenerationSignals: jsonb('lead_generation_signals').notNull().default(sql`'[]'::jsonb`),
    bookingSystemDetected: boolean('booking_system_detected'),
    crmDetected: text('crm_detected'),
    estimatedCompanySize: text('estimated_company_size'),
    ownerName: text('owner_name'),
    personalizationHooks: jsonb('personalization_hooks').notNull().default(sql`'[]'::jsonb`),
    researchNotes: text('research_notes'),
    researchSummary: text('research_summary'),
    researchPainPoints: jsonb('research_pain_points').notNull().default(sql`'[]'::jsonb`),
    researchOutreachAngle: text('research_outreach_angle'),
    researchConfidence: real('research_confidence'),
    researchedAt: timestamp('researched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('companies_org_idx').on(t.organizationId),
    index('companies_industry_idx').on(t.organizationId, t.industry),
    index('companies_name_idx').on(t.organizationId, t.name),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    /** E.164. The uniqueness key for dedupe within an org. */
    phone: text('phone').notNull(),
    phoneRaw: text('phone_raw'),
    email: text('email'),
    title: text('title'),
    timezone: text('timezone'),
    status: prospectStatusEnum('status').notNull().default('NEW'),
    source: text('source'),
    score: integer('score'),
    scoreBucket: text('score_bucket'),
    scoreBreakdown: jsonb('score_breakdown').notNull().default(sql`'[]'::jsonb`),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    scoringVersion: text('scoring_version'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    customFields: jsonb('custom_fields').notNull().default(sql`'{}'::jsonb`),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    nextAction: text('next_action'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contacts_org_phone_unique').on(t.organizationId, t.phone),
    index('contacts_org_status_idx').on(t.organizationId, t.status),
    index('contacts_company_idx').on(t.companyId),
    index('contacts_email_idx').on(t.organizationId, t.email),
    index('contacts_score_idx').on(t.organizationId, t.score),
    index('contacts_next_action_idx').on(t.organizationId, t.nextActionAt),
    index('contacts_created_idx').on(t.organizationId, t.createdAt),
  ],
);

/* --------------------------------------------------------------- providers */

export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: providerKindEnum('kind').notNull(),
    label: text('label').notNull(),
    /** Credentials live in env; this stores non-secret account identifiers. */
    accountRef: text('account_ref'),
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('provider_accounts_org_idx').on(t.organizationId)],
);

export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerAccountId: uuid('provider_account_id').references(() => providerAccounts.id, {
      onDelete: 'set null',
    }),
    number: text('number').notNull(),
    label: text('label'),
    active: boolean('active').notNull().default(true),
    dailyCap: integer('daily_cap').notNull().default(200),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('phone_numbers_org_number_unique').on(t.organizationId, t.number)],
);

/* --------------------------------------------------------------- campaigns */

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    industry: text('industry'),
    audience: jsonb('audience').notNull().default(sql`'{}'::jsonb`),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),
    dailyCapacity: integer('daily_capacity').notNull().default(50),
    sendingWindowStart: text('sending_window_start').notNull().default('09:00'),
    sendingWindowEnd: text('sending_window_end').notNull().default('19:00'),
    sendingDays: jsonb('sending_days').notNull().default(sql`'[1,2,3,4,5]'::jsonb`),
    timezone: text('timezone').notNull().default('America/Toronto'),
    messageStrategy: text('message_strategy'),
    fromPhoneNumberId: uuid('from_phone_number_id').references(() => phoneNumbers.id, {
      onDelete: 'set null',
    }),
    agentId: uuid('agent_id'),
    minScore: integer('min_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_org_status_idx').on(t.organizationId, t.status)],
);

export const campaignSteps = pgTable(
  'campaign_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    /** Hours to wait after the previous step before this step is eligible. */
    delayHours: integer('delay_hours').notNull().default(24),
    channel: text('channel').notNull().default('sms'),
    /** Conditions evaluated against the conversation before sending. */
    conditions: jsonb('conditions').notNull().default(sql`'[]'::jsonb`),
    stopConditions: jsonb('stop_conditions').notNull().default(sql`'["replied"]'::jsonb`),
    useAi: boolean('use_ai').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('campaign_steps_position_unique').on(t.campaignId, t.position),
    index('campaign_steps_campaign_idx').on(t.campaignId),
  ],
);

export const campaignVariants = pgTable(
  'campaign_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id')
      .notNull()
      .references(() => campaignSteps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Angle key: lost_leads | old_estimates | speed_to_lead | follow_up | curiosity | direct_offer */
    angle: text('angle').notNull().default('curiosity'),
    template: text('template').notNull(),
    weight: integer('weight').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaign_variants_step_idx').on(t.stepId)],
);

export const campaignMemberships = pgTable(
  'campaign_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: membershipStatusEnum('status').notNull().default('PENDING'),
    currentStepPosition: integer('current_step_position').notNull().default(0),
    nextStepAt: timestamp('next_step_at', { withTimezone: true }),
    stoppedReason: text('stopped_reason'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('campaign_memberships_unique').on(t.campaignId, t.contactId),
    index('campaign_memberships_due_idx').on(t.status, t.nextStepAt),
    index('campaign_memberships_contact_idx').on(t.contactId),
  ],
);

/* ----------------------------------------------------------- conversations */

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, { onDelete: 'set null' }),
    state: conversationStateEnum('state').notNull().default('NEW'),
    intent: intentEnum('intent').notNull().default('unknown'),
    leadTemperature: leadTemperatureEnum('lead_temperature').notNull().default('cold'),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    aiPausedReason: text('ai_paused_reason'),
    requiresHuman: boolean('requires_human').notNull().default(false),
    handoffReason: text('handoff_reason'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_contact_unique').on(t.organizationId, t.contactId),
    index('conversations_org_state_idx').on(t.organizationId, t.state),
    index('conversations_last_message_idx').on(t.organizationId, t.lastMessageAt),
    index('conversations_requires_human_idx').on(t.organizationId, t.requiresHuman),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    author: messageAuthorEnum('author').notNull(),
    status: messageStatusEnum('status').notNull().default('QUEUED'),
    body: text('body').notNull(),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    /** Attribution — every outbound message records how it was produced. */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    stepId: uuid('step_id').references(() => campaignSteps.id, { onDelete: 'set null' }),
    variantId: uuid('variant_id').references(() => campaignVariants.id, { onDelete: 'set null' }),
    promptVersion: text('prompt_version'),
    experimentId: uuid('experiment_id'),
    sentByUserId: uuid('sent_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    providerKind: providerKindEnum('provider_kind'),
    providerMessageId: text('provider_message_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    segments: integer('segments'),
    costCents: integer('cost_cents'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    index('messages_org_created_idx').on(t.organizationId, t.createdAt),
    index('messages_campaign_idx').on(t.campaignId),
    index('messages_variant_idx').on(t.variantId),
    uniqueIndex('messages_provider_id_unique').on(t.providerKind, t.providerMessageId),
  ],
);

export const messageEvents = pgTable(
  'message_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    providerKind: providerKindEnum('provider_kind'),
    providerMessageId: text('provider_message_id'),
    /** Provider-supplied dedupe key; makes webhook retries idempotent. */
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_events_dedupe_unique').on(t.dedupeKey),
    index('message_events_message_idx').on(t.messageId),
  ],
);

/* ------------------------------------------------------------------- queue */

export const outboundJobs = pgTable(
  'outbound_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    status: jobStatusEnum('status').notNull().default('PENDING'),
    /** Caller-supplied key. A duplicate key is a no-op, not a second send. */
    idempotencyKey: text('idempotency_key').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbound_jobs_idempotency_unique').on(t.organizationId, t.idempotencyKey),
    index('outbound_jobs_ready_idx').on(t.status, t.runAt),
  ],
);

/* ---------------------------------------------------------------------- AI */

export const aiPrompts = pgTable(
  'ai_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentType: agentTypeEnum('agent_type').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    prompt: text('prompt').notNull(),
    model: text('model'),
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ai_prompts_version_unique').on(t.organizationId, t.agentType, t.name, t.version),
    index('ai_prompts_active_idx').on(t.organizationId, t.agentType, t.active),
  ],
);

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    agentType: agentTypeEnum('agent_type').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull().default('standard'),
    ok: boolean('ok').notNull(),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costCents: integer('cost_cents'),
    output: jsonb('output'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_runs_conversation_idx').on(t.conversationId, t.createdAt),
    index('ai_runs_org_created_idx').on(t.organizationId, t.createdAt),
  ],
);

export const aiSummaries = pgTable(
  'ai_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    painIdentified: text('pain_identified'),
    currentProcess: text('current_process'),
    objections: jsonb('objections').notNull().default(sql`'[]'::jsonb`),
    opportunity: text('opportunity'),
    recommendedNextStep: text('recommended_next_step'),
    leadTemperature: leadTemperatureEnum('lead_temperature').notNull().default('cold'),
    messageCountAtSummary: integer('message_count_at_summary').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_summaries_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const qualifications = pgTable(
  'qualifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** { fieldKey: { value, source, confidence, capturedAt } } */
    fields: jsonb('fields').notNull().default(sql`'{}'::jsonb`),
    completeness: real('completeness').notNull().default(0),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('qualifications_conversation_unique').on(t.conversationId)],
);

/* --------------------------------------------------- knowledge & objections */

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    position: integer('position').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_org_category_idx').on(t.organizationId, t.category)],
);

export const objections = pgTable(
  'objections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    matchers: jsonb('matchers').notNull().default(sql`'[]'::jsonb`),
    strategy: text('strategy').notNull(),
    exampleResponses: jsonb('example_responses').notNull().default(sql`'[]'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('objections_org_idx').on(t.organizationId)],
);

/* ---------------------------------------------------- appointments & deals */

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    status: appointmentStatusEnum('status').notNull().default('SCHEDULED'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull().default('America/Toronto'),
    location: text('location'),
    notes: text('notes'),
    calendarProvider: text('calendar_provider'),
    externalEventId: text('external_event_id'),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointments_org_start_idx').on(t.organizationId, t.startsAt),
    index('appointments_contact_idx').on(t.contactId),
  ],
);

export const pipelineDeals = pgTable(
  'pipeline_deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    /** Attribution chain: which campaign/variant produced this revenue. */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    variantId: uuid('variant_id').references(() => campaignVariants.id, { onDelete: 'set null' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    stage: pipelineStageEnum('stage').notNull().default('NEW'),
    valueCents: integer('value_cents').notNull().default(0),
    recurringValueCents: integer('recurring_value_cents').notNull().default(0),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    wonAt: timestamp('won_at', { withTimezone: true }),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pipeline_deals_org_stage_idx').on(t.organizationId, t.stage),
    index('pipeline_deals_contact_idx').on(t.contactId),
    index('pipeline_deals_campaign_idx').on(t.campaignId),
  ],
);

/* ----------------------------------------------------- activity & workflow */

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    type: activityTypeEnum('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind').notNull().default('system'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('activities_contact_idx').on(t.contactId, t.createdAt),
    index('activities_org_created_idx').on(t.organizationId, t.createdAt),
    index('activities_conversation_idx').on(t.conversationId, t.createdAt),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id').references(() => pipelineDeals.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    kind: text('kind').notNull().default('follow_up'),
    notes: text('notes'),
    status: taskStatusEnum('status').notNull().default('OPEN'),
    priority: integer('priority').notNull().default(2),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tasks_org_status_due_idx').on(t.organizationId, t.status, t.dueAt),
    index('tasks_contact_idx').on(t.contactId),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_org_read_idx').on(t.organizationId, t.readAt, t.createdAt)],
);

export const suppressionEntries = pgTable(
  'suppression_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    reason: suppressionReasonEnum('reason').notNull(),
    note: text('note'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('suppression_org_phone_unique').on(t.organizationId, t.phone)],
);

/* ---------------------------------------------------------- experimentation */

export const experiments = pgTable(
  'experiments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** opening_angle | wording | cta | delay | personalization | prompt_version | audience */
    variable: text('variable').notNull(),
    hypothesis: text('hypothesis'),
    status: text('status').notNull().default('running'),
    minSampleSize: integer('min_sample_size').notNull().default(100),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    winningVariantId: uuid('winning_variant_id').references(() => campaignVariants.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('experiments_org_idx').on(t.organizationId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    requestId: text('request_id'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt)],
);

export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    errors: jsonb('errors').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('import_batches_org_idx').on(t.organizationId, t.createdAt)],
);

/* --------------------------------------------------------------- relations */

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  memberships: many(memberships),
  contacts: many(contacts),
  settings: one(orgSettings, {
    fields: [organizations.id],
    references: [orgSettings.organizationId],
  }),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  owner: one(users, { fields: [contacts.ownerUserId], references: [users.id] }),
  conversation: one(conversations, {
    fields: [contacts.id],
    references: [conversations.contactId],
  }),
  memberships: many(campaignMemberships),
  activities: many(activities),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  campaign: one(campaigns, { fields: [conversations.campaignId], references: [campaigns.id] }),
  assignee: one(users, { fields: [conversations.assignedUserId], references: [users.id] }),
  messages: many(messages),
  qualification: one(qualifications, {
    fields: [conversations.id],
    references: [qualifications.conversationId],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  contact: one(contacts, { fields: [messages.contactId], references: [contacts.id] }),
  variant: one(campaignVariants, {
    fields: [messages.variantId],
    references: [campaignVariants.id],
  }),
}));

export const campaignsRelations = relations(campaigns, ({ many, one }) => ({
  steps: many(campaignSteps),
  memberships: many(campaignMemberships),
  fromPhoneNumber: one(phoneNumbers, {
    fields: [campaigns.fromPhoneNumberId],
    references: [phoneNumbers.id],
  }),
}));

export const campaignStepsRelations = relations(campaignSteps, ({ many, one }) => ({
  variants: many(campaignVariants),
  campaign: one(campaigns, { fields: [campaignSteps.campaignId], references: [campaigns.id] }),
}));

export const companiesRelations = relations(companies, ({ many }) => ({
  contacts: many(contacts),
}));
