ALTER TABLE "companies" ADD COLUMN "service_areas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "services" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD COLUMN "crawl_status" text;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD COLUMN "crawl_error" text;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD COLUMN "crawled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_discovery_records" ADD COLUMN "pages_crawled" integer;--> statement-breakpoint
ALTER TABLE "lead_search_jobs" ADD COLUMN "crawled_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_search_jobs" ADD COLUMN "crawl_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_search_jobs" ADD COLUMN "qualified_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "source_url" text;