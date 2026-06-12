CREATE TABLE "size_scales" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"values" jsonb NOT NULL,
	"category_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "variant_groups" ADD COLUMN "color_hex" text;