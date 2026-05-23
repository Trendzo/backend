ALTER TYPE "listing_status" ADD VALUE IF NOT EXISTS 'taken_down';--> statement-breakpoint
ALTER TABLE "product_listings" ADD COLUMN IF NOT EXISTS "status_before_takedown" "listing_status";
