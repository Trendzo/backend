-- 0070: Home CMS — admin-editable merchandising content for the consumer app.
--
-- Hand-authored, not generated: the meta/ snapshots stop at 0037_snapshot.json, so
-- `drizzle-kit generate` can no longer diff correctly and would bundle unrelated drift
-- (reels, community, avatar_url, …) into this file. Journal entry appended by hand.
--
-- Editing model: cms_sections + cms_items ARE the draft. Publishing renders them into an
-- immutable cms_publications snapshot; the public endpoint reads only the latest snapshot.
-- Scheduling and city targeting are applied when the snapshot is READ, so a campaign dated
-- for next week can be published today and appear on its own.

-- Audience, not product gender. The existing `gender` enum says what an item suits
-- ('unisex'); this says which rail renders a banner ('all' = both).
DO $$ BEGIN
 CREATE TYPE "cms_gender" AS ENUM ('her', 'him', 'all');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "cms_media_kind" AS ENUM ('image', 'video');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- One fixed content slot per row (home.hero, page.edit_her, …). Seeded set: admin edits
-- these, it does not create or delete them. sort_order is stored but unread — the app's JSX
-- still owns section order — so a later server-driven layout needs no migration.
CREATE TABLE IF NOT EXISTS "cms_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"subtitle" text,
	"kicker" text,
	"cta_label" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cms_sections" ADD CONSTRAINT "cms_sections_updated_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cms_sections_key_idx" ON "cms_sections" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_sections_order_idx" ON "cms_sections" ("sort_order");
--> statement-breakpoint
-- Cards / slides / tiles. Media is two-headed on purpose: asset_key names art bundled in the
-- app binary (no network, works offline, keeps today's performance), image_url is art an
-- admin uploaded. The app prefers image_url and falls back to asset_key.
CREATE TABLE IF NOT EXISTS "cms_items" (
	"id" text PRIMARY KEY NOT NULL,
	"section_id" text NOT NULL,
	"key" text NOT NULL,
	"gender" "cms_gender" DEFAULT 'all' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"asset_key" text,
	"image_url" text,
	"video_url" text,
	"link" jsonb,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"cities" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cms_items_window_guard" CHECK (
		"starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cms_items" ADD CONSTRAINT "cms_items_section_id_cms_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "cms_sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The app keys its rendered list on (section, key), so the pair has to be unique.
CREATE UNIQUE INDEX IF NOT EXISTS "cms_items_section_key_idx" ON "cms_items" ("section_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_items_section_order_idx" ON "cms_items" ("section_id","sort_order");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_items_section_gender_idx" ON "cms_items" ("section_id","gender");
--> statement-breakpoint
-- Immutable render of the whole draft at one moment. Restoring an older version copies its
-- payload back into the draft tables; nothing is ever deleted, so history stays intact.
CREATE TABLE IF NOT EXISTS "cms_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"note" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_admin_id" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cms_publications" ADD CONSTRAINT "cms_publications_published_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("published_by_admin_id") REFERENCES "admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Version is allocated as max(version) + 1 inside the publish transaction; this index is what
-- makes two concurrent publishes collide (23505) instead of both claiming the same number.
CREATE UNIQUE INDEX IF NOT EXISTS "cms_publications_version_idx" ON "cms_publications" ("version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_publications_published_at_idx" ON "cms_publications" ("published_at");
--> statement-breakpoint
-- Catalogue of art bundled in the app binary. Exists only so the admin picker can preview
-- assets it cannot otherwise see — a web page cannot resolve a React Native require().
-- preview_url points at a copy of the same file in object storage. The app never reads this.
CREATE TABLE IF NOT EXISTS "cms_assets" (
	"key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"kind" "cms_media_kind" DEFAULT 'image' NOT NULL,
	"preview_url" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_assets_category_idx" ON "cms_assets" ("category");
