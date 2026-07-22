-- 0064: Bulk-mockup generation queue (beta).
--
-- Async, non-blocking counterpart to ai_catalog_submissions. A background
-- claim-worker (FOR UPDATE SKIP LOCKED) picks `queued` jobs, generates the
-- multi-angle set, and writes the URLs to output_urls.
CREATE TYPE "bulk_mockup_status" AS ENUM ('queued', 'processing', 'ready', 'failed', 'cancelled', 'dismissed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bulk_mockup_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"mode" "ai_catalog_mode" NOT NULL,
	"prompt" text,
	"request" jsonb NOT NULL,
	"reference_image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "bulk_mockup_status" DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bulk_mockup_jobs" ADD CONSTRAINT "bulk_mockup_jobs_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "retailer_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bulk_mockup_jobs_store_status_idx" ON "bulk_mockup_jobs" ("store_id","status","created_at");
