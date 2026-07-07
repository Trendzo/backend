-- Admin-published T&C versions + accept/decline audit.
-- Hand-authored (do NOT db:push). Idempotent.

CREATE TABLE IF NOT EXISTS "retailer_terms" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "short_text" text NOT NULL,
  "created_by_admin_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Record decision (accept vs decline) on each terms decision row.
ALTER TABLE "retailer_terms_acceptances" ADD COLUMN IF NOT EXISTS "decision" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
-- Replace the plain unique(store,version) with a PARTIAL unique that only constrains
-- ACCEPTS — declines are an append-only log so a retailer can decline repeatedly.
DROP INDEX IF EXISTS "retailer_terms_acceptances_store_version_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retailer_terms_acceptances_store_version_idx"
  ON "retailer_terms_acceptances" ("store_id","terms_version") WHERE "decision" = 'accepted';
