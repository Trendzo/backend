-- 0078: Per-app privacy policy pages (admin-editable).
--
-- Hand-authored, not generated (meta/ snapshots stop at 0037_snapshot.json, so
-- drizzle-kit generate can no longer diff correctly). Journal entry appended by hand.
--
-- One editable row per app (customer|retailer|driver). The public /privacy/:app page
-- falls back to the built-in default in shared/app-privacy-content.ts when no row
-- exists, so this table can ship empty and the URL is never blank.
CREATE TABLE IF NOT EXISTS "app_privacy_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "app" text NOT NULL,
  "title" text NOT NULL,
  "body_html" text NOT NULL,
  "effective_date" text NOT NULL,
  "updated_by_admin_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_privacy_policies_app_idx" ON "app_privacy_policies" ("app");
