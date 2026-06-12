ALTER TABLE "product_listings" ADD COLUMN "age_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill the legacy single-select enum into numeric ranges.
UPDATE "product_listings"
SET "age_groups" = CASE "age_group"
	WHEN 'kids' THEN '["0-2","3-7","8-12"]'::jsonb
	WHEN 'teens' THEN '["13-17"]'::jsonb
	WHEN 'adults' THEN '["18-24","25-40","40+"]'::jsonb
	WHEN 'all' THEN '["0-2","3-7","8-12","13-17","18-24","25-40","40+"]'::jsonb
	ELSE '[]'::jsonb
END
WHERE "age_group" IS NOT NULL;
