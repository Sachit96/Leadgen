import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as s from './schema';

export type Organization = InferSelectModel<typeof s.organizations>;
export type User = InferSelectModel<typeof s.users>;
export type Membership = InferSelectModel<typeof s.memberships>;
export type OrgSettingsRow = InferSelectModel<typeof s.orgSettings>;
export type Company = InferSelectModel<typeof s.companies>;
export type NewCompany = InferInsertModel<typeof s.companies>;
export type Contact = InferSelectModel<typeof s.contacts>;
export type NewContact = InferInsertModel<typeof s.contacts>;
export type Campaign = InferSelectModel<typeof s.campaigns>;
export type CampaignStep = InferSelectModel<typeof s.campaignSteps>;
export type CampaignVariant = InferSelectModel<typeof s.campaignVariants>;
export type CampaignMembership = InferSelectModel<typeof s.campaignMemberships>;
export type Conversation = InferSelectModel<typeof s.conversations>;
export type Message = InferSelectModel<typeof s.messages>;
export type OutboundJob = InferSelectModel<typeof s.outboundJobs>;
export type Appointment = InferSelectModel<typeof s.appointments>;
export type PipelineDeal = InferSelectModel<typeof s.pipelineDeals>;
export type Activity = InferSelectModel<typeof s.activities>;
export type Task = InferSelectModel<typeof s.tasks>;
export type Notification = InferSelectModel<typeof s.notifications>;
export type PhoneNumber = InferSelectModel<typeof s.phoneNumbers>;
export type Qualification = InferSelectModel<typeof s.qualifications>;
export type AiSummary = InferSelectModel<typeof s.aiSummaries>;
export type AiPrompt = InferSelectModel<typeof s.aiPrompts>;
export type KnowledgeEntry = InferSelectModel<typeof s.knowledgeEntries>;
export type Objection = InferSelectModel<typeof s.objections>;
export type SuppressionEntry = InferSelectModel<typeof s.suppressionEntries>;

export type SavedSearch = InferSelectModel<typeof s.savedSearches>;
export type LeadSearchJob = InferSelectModel<typeof s.leadSearchJobs>;
export type LeadDiscoveryRecord = InferSelectModel<typeof s.leadDiscoveryRecords>;
export type NewLeadDiscoveryRecord = InferInsertModel<typeof s.leadDiscoveryRecords>;
export type LeadJob = InferSelectModel<typeof s.leadJobs>;
export type LeadEnrichmentRow = InferSelectModel<typeof s.leadEnrichment>;
export type LeadSignal = InferSelectModel<typeof s.leadSignals>;
export type LeadPersonalizationRow = InferSelectModel<typeof s.leadPersonalization>;
export type DuplicateMatch = InferSelectModel<typeof s.duplicateMatches>;
export type CallQueue = InferSelectModel<typeof s.callQueues>;
export type CallQueueItem = InferSelectModel<typeof s.callQueueItems>;
export type CallAttempt = InferSelectModel<typeof s.callAttempts>;

export type {
  UserRole,
  ProspectStatus,
  CampaignStatus,
  ConversationState,
  MessageStatus,
  MessageDirection,
  MessageAuthor,
  PipelineStage,
  AppointmentStatus,
  ActivityType,
  Intent,
  LeadTemperature,
  AgentType,
  JobStatus,
  SuppressionReason,
  ProviderKind,
  NotificationType,
  MembershipStatus,
  SearchJobStatus,
  LeadStage,
  LeadJobType,
  LeadJobStatus,
  DiscoveryProviderKind,
  DuplicateReason,
  CallReadiness,
  CallQueueStatus,
  CallQueueItemStatus,
  CallOutcome,
  PrimaryDisposition,
  CallProviderKind,
  NextAction,
} from '@/lib/constants/enums';

export {
  PROSPECT_STATUSES,
  CONVERSATION_STATES,
  PIPELINE_STAGES,
  CAMPAIGN_STATUSES,
  USER_ROLES,
  SEARCH_JOB_STATUSES,
  LEAD_STAGES,
  CALL_OUTCOMES,
  PRIMARY_DISPOSITIONS,
  CALL_READINESS,
} from '@/lib/constants/enums';
