-- 0079: Festival themes — server-driven theming for the consumer app.
--
-- Hand-authored, not generated: the meta/ snapshots stop at 0037_snapshot.json, so
-- `drizzle-kit generate` can no longer diff correctly. Mirrors src/db/schema/cms-themes.ts
-- column-for-column (the schema file is what tests run against via drizzle-kit push; this
-- file is what production runs). Journal entry appended by hand.
--
-- Two tables, twin-shaped to the Home CMS: cms_themes rows ARE the draft; publishing
-- freezes every enabled row into an immutable cms_theme_publications snapshot. Targeting
-- (window/cities/platforms/min_app_version) is evaluated at read time by the resolver.
CREATE TABLE IF NOT EXISTS "cms_themes" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_enabled" boolean DEFAULT true NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "cities" jsonb,
  "platforms" jsonb,
  "min_app_version" text,
  "tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "chrome" jsonb NOT NULL,
  "decor" jsonb NOT NULL,
  "copy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_admin_id" text,
  "updated_by_admin_id" text,
  CONSTRAINT "cms_themes_window_guard" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cms_themes" ADD CONSTRAINT "cms_themes_created_by_admin_id_admin_accounts_id_fk"
    FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cms_themes" ADD CONSTRAINT "cms_themes_updated_by_admin_id_admin_accounts_id_fk"
    FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cms_themes_slug_idx" ON "cms_themes" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_themes_enabled_idx" ON "cms_themes" ("is_enabled");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cms_theme_publications" (
  "id" text PRIMARY KEY NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "note" text,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_by_admin_id" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cms_theme_publications" ADD CONSTRAINT "cms_theme_publications_published_by_admin_id_admin_accounts_id_fk"
    FOREIGN KEY ("published_by_admin_id") REFERENCES "admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Version allocated as max(version)+1 under pg_advisory_xact_lock; this index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "cms_theme_publications_version_idx" ON "cms_theme_publications" ("version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_theme_publications_published_at_idx" ON "cms_theme_publications" ("published_at");
