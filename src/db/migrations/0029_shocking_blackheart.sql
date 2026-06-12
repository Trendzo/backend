CREATE TYPE "public"."variant_mode" AS ENUM('single', 'color_size', 'custom');--> statement-breakpoint
CREATE TABLE "variant_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_listings" ADD COLUMN "variant_mode" "variant_mode" DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "variant_groups" ADD CONSTRAINT "variant_groups_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_groups" ADD CONSTRAINT "variant_groups_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variant_groups_listing_idx" ON "variant_groups" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_groups_listing_name_idx" ON "variant_groups" USING btree ("listing_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "variant_groups_listing_default_idx" ON "variant_groups" USING btree ("listing_id") WHERE "variant_groups"."is_default";--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_group_id_variant_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."variant_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variants_group_idx" ON "variants" USING btree ("group_id");--> statement-breakpoint
-- ===== Data backfill (hand-written; do NOT db:push this migration) ==========
-- A. One color group per (listing, distinct color value) — only for listings
--    WITHOUT a custom attribute template (custom listings stay flat inside the
--    default group; deriving color groups there would let a group rename
--    rewrite template-validated attributes). Seeds/CSV used mixed key
--    spellings, so match color/colour in any case.
INSERT INTO "variant_groups" ("id", "listing_id", "store_id", "name", "sort_order", "is_default")
SELECT
	'vgrp_' || replace(gen_random_uuid()::text, '-', ''),
	c.listing_id,
	c.store_id,
	c.color,
	row_number() OVER (PARTITION BY c.listing_id ORDER BY c.color) - 1,
	false
FROM (
	SELECT DISTINCT
		v.listing_id,
		v.store_id,
		COALESCE(
			v.attributes ->> 'color',
			v.attributes ->> 'colour',
			v.attributes ->> 'Color',
			v.attributes ->> 'Colour'
		) AS color
	FROM "variants" v
	JOIN "product_listings" pl ON pl.id = v.listing_id
	WHERE pl.template_id IS NULL
	AND COALESCE(
		v.attributes ->> 'color',
		v.attributes ->> 'colour',
		v.attributes ->> 'Color',
		v.attributes ->> 'Colour'
	) IS NOT NULL
) c
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- B. A default group for every listing that still needs one: custom-template
--    listings, listings with color-less variants, and zero-variant drafts.
INSERT INTO "variant_groups" ("id", "listing_id", "store_id", "name", "sort_order", "is_default")
SELECT
	'vgrp_' || replace(gen_random_uuid()::text, '-', ''),
	l.id,
	l.store_id,
	'Default',
	0,
	true
FROM "product_listings" l
WHERE l.template_id IS NOT NULL
OR EXISTS (
	SELECT 1 FROM "variants" v
	WHERE v.listing_id = l.id
	AND COALESCE(
		v.attributes ->> 'color',
		v.attributes ->> 'colour',
		v.attributes ->> 'Color',
		v.attributes ->> 'Colour'
	) IS NULL
)
OR NOT EXISTS (SELECT 1 FROM "variant_groups" g WHERE g.listing_id = l.id)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- C1. Assign variants to their color group (case-insensitive name match;
--     color groups only exist for template-free listings after step A).
UPDATE "variants" v
SET "group_id" = g.id
FROM "variant_groups" g
WHERE g.listing_id = v.listing_id
AND NOT g.is_default
AND v.group_id IS NULL
AND lower(g.name) = lower(COALESCE(
	v.attributes ->> 'color',
	v.attributes ->> 'colour',
	v.attributes ->> 'Color',
	v.attributes ->> 'Colour'
));--> statement-breakpoint
-- C2. Route the remainder (no color value) to the listing's default group.
UPDATE "variants" v
SET "group_id" = g.id
FROM "variant_groups" g
WHERE g.listing_id = v.listing_id
AND g.is_default
AND v.group_id IS NULL;--> statement-breakpoint
-- D. Record each listing's variant mode: custom when a template is attached,
--    color_size when it has named (non-default) groups, custom also for
--    template-free flat listings whose variants carry attributes (e.g.
--    size-only — they need the flat editor, not the single-product one),
--    else single.
UPDATE "product_listings" l
SET "variant_mode" = CASE
	WHEN l.template_id IS NOT NULL THEN 'custom'::"variant_mode"
	WHEN EXISTS (
		SELECT 1 FROM "variant_groups" g
		WHERE g.listing_id = l.id AND NOT g.is_default
	) THEN 'color_size'::"variant_mode"
	WHEN EXISTS (
		SELECT 1 FROM "variants" v
		WHERE v.listing_id = l.id AND v.attributes <> '{}'::jsonb
	) THEN 'custom'::"variant_mode"
	ELSE 'single'::"variant_mode"
END;--> statement-breakpoint
ALTER TABLE "variants" ALTER COLUMN "group_id" SET NOT NULL;
