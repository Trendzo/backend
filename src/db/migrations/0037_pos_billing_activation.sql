ALTER TYPE "public"."change_request_field" ADD VALUE 'pos_billing_activation';--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "pos_billing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: existing stores retain current POS access. New default is false; enable only
-- for stores that have actually used POS (>=1 pos_sales row). Active stores with zero POS
-- history are intentionally left disabled for an explicit admin decision (not silently
-- toggled). See prompts/billing-per-retailer.md Phase 2.
UPDATE "retailer_stores" s SET "pos_billing_enabled" = true
WHERE EXISTS (SELECT 1 FROM "pos_sales" p WHERE p."store_id" = s."id");
