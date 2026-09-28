-- 0080: AI product copy — name + short/long description drafted from the retailer's
-- photos on the same call as the mockups (shared/ai-catalog/product-copy.ts).
--
-- Hand-authored, not generated (meta/ snapshots stop at 0037). Mirrors the `copy`
-- column in src/db/schema/catalog.ts and src/db/schema/bulk-mockups.ts. Journal entry
-- appended by hand. Nullable: null = copy generation failed or is disabled.
--
-- Render does NOT auto-migrate: apply this to prod BEFORE deploying the code, or every
-- submission / bulk-job read fails with 42703 (column does not exist).
ALTER TABLE "ai_catalog_submissions" ADD COLUMN IF NOT EXISTS "copy" jsonb;
--> statement-breakpoint
ALTER TABLE "bulk_mockup_jobs" ADD COLUMN IF NOT EXISTS "copy" jsonb;
