CREATE TYPE "public"."call_outcome" AS ENUM('INITIATED', 'CONNECTED', 'BOOKED', 'NO_ANSWER', 'CALLBACK', 'NOT_INTERESTED', 'WRONG_NUMBER', 'VOICEMAIL', 'BUSY', 'CONNECTED_NO_INTEREST', 'QUALIFIED', 'FOLLOW_UP', 'BAD_NUMBER', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."call_provider" AS ENUM('device', 'twilio_voice', 'telnyx_voice');--> statement-breakpoint
CREATE TYPE "public"."call_queue_item_status" AS ENUM('PENDING', 'CURRENT', 'COMPLETED', 'SKIPPED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."call_queue_status" AS ENUM('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."call_readiness" AS ENUM('NOT_READY', 'READY', 'QUEUED', 'CALLED', 'CALLBACK', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."discovery_provider" AS ENUM('google_places', 'csv', 'mock');--> statement-breakpoint
CREATE TYPE "public"."duplicate_reason" AS ENUM('place_id', 'phone', 'website_domain', 'email', 'name_and_address');--> statement-breakpoint
CREATE TYPE "public"."lead_job_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'SKIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."lead_job_type" AS ENUM('lead_discovery', 'lead_normalization', 'lead_deduplication', 'website_enrichment', 'social_enrichment', 'contact_enrichment', 'ai_research', 'lead_scoring', 'personalization_generation', 'campaign_assignment', 'call_queue_generation');--> statement-breakpoint
CREATE TYPE "public"."lead_stage" AS ENUM('DISCOVERED', 'NORMALIZED', 'DUPLICATE', 'ENRICHING', 'ENRICHED', 'RESEARCHED', 'SCORED', 'PERSONALIZED', 'REVIEW', 'APPROVED', 'REJECTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."search_job_status" AS ENUM('DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'discovery_started';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'business_discovered';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'lead_normalized';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'duplicate_matched';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'enrichment_started';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'enrichment_completed';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'signals_detected';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'lead_approved';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'lead_rejected';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'call_queue_added';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'call_queue_removed';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'call_initiated';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'call_outcome';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'call_note';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'callback_scheduled';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'call_skipped';--> statement-breakpoint
CREATE TABLE "call_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"queue_id" uuid,
	"queue_item_id" uuid,
	"user_id" uuid,
	"campaign_id" uuid,
	"phone_number" text NOT NULL,
	"provider" "call_provider" DEFAULT 'device' NOT NULL,
	"outcome" "call_outcome" DEFAULT 'INITIATED' NOT NULL,
	"connection_reported" boolean DEFAULT false NOT NULL,
	"duration_seconds" integer,
	"not_interested_reason" text,
	"note" text,
	"external_call_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"dispositioned_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" "call_queue_item_status" DEFAULT 'PENDING' NOT NULL,
	"priority_score" real DEFAULT 0 NOT NULL,
	"outcome" "call_outcome",
	"skip_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_queue_items_position_unique" UNIQUE("queue_id","position"),
	CONSTRAINT "call_queue_items_contact_unique" UNIQUE("queue_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "call_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "call_queue_status" DEFAULT 'ACTIVE' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assigned_user_id" uuid,
	"campaign_id" uuid,
	"total_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"discovery_record_id" uuid,
	"matched_company_id" uuid,
	"reason" "duplicate_reason" NOT NULL,
	"score" real NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_discovery_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"search_job_id" uuid,
	"provider" "discovery_provider" NOT NULL,
	"external_id" text,
	"stage" "lead_stage" DEFAULT 'DISCOVERED' NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"business_name" text NOT NULL,
	"name_key" text,
	"phone" text,
	"phone_raw" text,
	"email" text,
	"website" text,
	"website_domain" text,
	"address_line" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"country" text,
	"category" text,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"google_rating" real,
	"google_review_count" integer,
	"latitude" real,
	"longitude" real,
	"hours" jsonb,
	"social_urls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"duplicate_of_company_id" uuid,
	"duplicate_reason" "duplicate_reason",
	"duplicate_score" real,
	"company_id" uuid,
	"contact_id" uuid,
	"error_code" text,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lead_enrichment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"content_hash" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pages_fetched" integer,
	"bytes_fetched" integer,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "lead_job_type" NOT NULL,
	"status" "lead_job_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_job_id" uuid,
	"discovery_record_id" uuid,
	"company_id" uuid,
	"contact_id" uuid,
	"priority" integer DEFAULT 5 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_personalization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"campaign_id" uuid,
	"hook" text,
	"recommended_angle" text,
	"opening_message" text,
	"call_opener" text,
	"confidence" real,
	"prompt_version" text,
	"approval_status" text DEFAULT 'NOT_READY' NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_search_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"saved_search_id" uuid,
	"query" text NOT NULL,
	"location" text NOT NULL,
	"radius_meters" integer DEFAULT 25000 NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" "discovery_provider" DEFAULT 'mock' NOT NULL,
	"status" "search_job_status" DEFAULT 'DRAFT' NOT NULL,
	"requested_count" integer DEFAULT 100 NOT NULL,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"unique_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"enriched_count" integer DEFAULT 0 NOT NULL,
	"researched_count" integer DEFAULT 0 NOT NULL,
	"scored_count" integer DEFAULT 0 NOT NULL,
	"approved_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"value" text,
	"detected" boolean DEFAULT true NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"evidence" text,
	"source" text NOT NULL,
	"inferred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"location" text NOT NULL,
	"radius_meters" integer DEFAULT 25000 NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_searches_org_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "discovery_source" "discovery_provider";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "name_key" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "website_domain" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "latitude" real;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "longitude" real;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "categories" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "hours" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "website_quality_score" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "website_quality_version" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "data_completeness" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "call_readiness" "call_readiness" DEFAULT 'NOT_READY' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone_confidence" real;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone_validated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "call_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "no_answer_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_call_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_call_outcome" "call_outcome";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "next_callback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone_invalid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_queue_id_call_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."call_queues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_queue_item_id_call_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."call_queue_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queue_items" ADD CONSTRAINT "call_queue_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queue_items" ADD CONSTRAINT "call_queue_items_queue_id_call_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."call_queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queue_items" ADD CONSTRAINT "call_queue_items_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queues" ADD CONSTRAINT "call_queues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queues" ADD CONSTRAINT "call_queues_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queues" ADD CONSTRAINT "call_queues_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_queues" ADD CONSTRAINT "call_queues_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_discovery_record_id_lead_discovery_records_id_fk" FOREIGN KEY ("discovery_record_id") REFERENCES "public"."lead_discovery_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_matched_company_id_companies_id_fk" FOREIGN KEY ("matched_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD CONSTRAINT "lead_discovery_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD CONSTRAINT "lead_discovery_records_search_job_id_lead_search_jobs_id_fk" FOREIGN KEY ("search_job_id") REFERENCES "public"."lead_search_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD CONSTRAINT "lead_discovery_records_duplicate_of_company_id_companies_id_fk" FOREIGN KEY ("duplicate_of_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD CONSTRAINT "lead_discovery_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD CONSTRAINT "lead_discovery_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_enrichment" ADD CONSTRAINT "lead_enrichment_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_enrichment" ADD CONSTRAINT "lead_enrichment_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_jobs" ADD CONSTRAINT "lead_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_jobs" ADD CONSTRAINT "lead_jobs_search_job_id_lead_search_jobs_id_fk" FOREIGN KEY ("search_job_id") REFERENCES "public"."lead_search_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_jobs" ADD CONSTRAINT "lead_jobs_discovery_record_id_lead_discovery_records_id_fk" FOREIGN KEY ("discovery_record_id") REFERENCES "public"."lead_discovery_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_jobs" ADD CONSTRAINT "lead_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_jobs" ADD CONSTRAINT "lead_jobs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_personalization" ADD CONSTRAINT "lead_personalization_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_personalization" ADD CONSTRAINT "lead_personalization_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_personalization" ADD CONSTRAINT "lead_personalization_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_personalization" ADD CONSTRAINT "lead_personalization_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_search_jobs" ADD CONSTRAINT "lead_search_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_search_jobs" ADD CONSTRAINT "lead_search_jobs_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_search_jobs" ADD CONSTRAINT "lead_search_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_attempts_contact_idx" ON "call_attempts" USING btree ("contact_id","started_at");--> statement-breakpoint
CREATE INDEX "call_attempts_org_started_idx" ON "call_attempts" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "call_attempts_queue_idx" ON "call_attempts" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "call_queue_items_next_idx" ON "call_queue_items" USING btree ("queue_id","status","position");--> statement-breakpoint
CREATE INDEX "call_queues_org_status_idx" ON "call_queues" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "duplicate_matches_company_idx" ON "duplicate_matches" USING btree ("matched_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_discovery_external_unique" ON "lead_discovery_records" USING btree ("organization_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "lead_discovery_job_stage_idx" ON "lead_discovery_records" USING btree ("search_job_id","stage");--> statement-breakpoint
CREATE INDEX "lead_discovery_org_stage_idx" ON "lead_discovery_records" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE INDEX "lead_discovery_phone_idx" ON "lead_discovery_records" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE INDEX "lead_enrichment_company_kind_idx" ON "lead_enrichment" USING btree ("company_id","kind","version");--> statement-breakpoint
CREATE INDEX "lead_enrichment_org_idx" ON "lead_enrichment" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_jobs_idempotency_unique" ON "lead_jobs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "lead_jobs_ready_idx" ON "lead_jobs" USING btree ("status","scheduled_at","priority");--> statement-breakpoint
CREATE INDEX "lead_jobs_search_idx" ON "lead_jobs" USING btree ("search_job_id","type","status");--> statement-breakpoint
CREATE INDEX "lead_personalization_contact_idx" ON "lead_personalization" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_search_jobs_org_status_idx" ON "lead_search_jobs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "lead_search_jobs_created_idx" ON "lead_search_jobs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_signals_company_key_unique" ON "lead_signals" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "lead_signals_org_key_idx" ON "lead_signals" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_org_external_unique" ON "companies" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "companies_name_key_idx" ON "companies" USING btree ("organization_id","name_key");--> statement-breakpoint
CREATE INDEX "companies_domain_idx" ON "companies" USING btree ("organization_id","website_domain");--> statement-breakpoint
CREATE INDEX "contacts_call_readiness_idx" ON "contacts" USING btree ("organization_id","call_readiness");--> statement-breakpoint
CREATE INDEX "contacts_callback_idx" ON "contacts" USING btree ("organization_id","next_callback_at");