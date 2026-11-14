ALTER TABLE product_listings ALTER COLUMN category_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE product_listings ALTER COLUMN gender DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE product_listings ALTER COLUMN name SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE product_listings ADD COLUMN IF NOT EXISTS draft_variant_data jsonb;
