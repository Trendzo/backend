ALTER TYPE "collection_kind" ADD VALUE IF NOT EXISTS 'brand';--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "brand_id" text REFERENCES "brands"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "occasion_tag" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_brand_idx" ON "collections"("brand_id") WHERE "brand_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_occasion_tag_idx" ON "collections"("occasion_tag") WHERE "occasion_tag" IS NOT NULL;
