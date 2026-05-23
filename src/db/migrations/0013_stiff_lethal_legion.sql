ALTER TABLE "product_listings" ADD COLUMN "occasion" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_listings" ADD COLUMN "age_group" text;