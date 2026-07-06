-- POS day session — opening float + end-of-day cash reconciliation (Z-report).
-- Hand-authored (do NOT db:push). Idempotent via IF NOT EXISTS / DO block.

DO $$ BEGIN
  CREATE TYPE "pos_day_session_status" AS ENUM('open','closed');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_day_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "store_id" text NOT NULL REFERENCES "retailer_stores"("id") ON DELETE cascade,
  "business_date" text NOT NULL,
  "status" "pos_day_session_status" DEFAULT 'open' NOT NULL,
  "opened_by_account_id" text NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "opening_float_paise" integer DEFAULT 0 NOT NULL,
  "closed_by_account_id" text,
  "closed_at" timestamp with time zone,
  "counted_cash_paise" integer,
  "expected_cash_paise" integer,
  "cash_variance_paise" integer,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_day_sessions_store_date_idx" ON "pos_day_sessions" ("store_id","business_date");
