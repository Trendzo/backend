-- 0072: Track who created a brand so retailer logo edits can be creator-owned.

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "created_by_retailer_account_id" text;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "created_by_admin_id" text;

DO $$ BEGIN
 ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_retailer_account_id_retailer_accounts_id_fk"
   FOREIGN KEY ("created_by_retailer_account_id") REFERENCES "public"."retailer_accounts"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_admin_id_admin_accounts_id_fk"
   FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_accounts"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
