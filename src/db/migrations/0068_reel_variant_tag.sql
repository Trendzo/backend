-- Reels: tag a specific VARIANT, not just the listing.
--
-- A creator picking "the black one in M" had nowhere to record it — `reels.product_id`
-- was the whole tag — so every reel about a multi-variant product pointed at the
-- listing's default image regardless of what was actually on screen.
--
-- ON DELETE SET NULL, matching `product_id`: a variant being delisted must not orphan
-- or delete somebody's video, it just degrades the tag back to the listing.
ALTER TABLE "reels" ADD COLUMN IF NOT EXISTS "variant_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reels" ADD CONSTRAINT "reels_variant_id_variants_id_fk"
   FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
