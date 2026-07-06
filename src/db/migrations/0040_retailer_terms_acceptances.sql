-- Retailer T&C acceptance — the legal record that a store accepted a terms version
-- before going live. Hand-authored (do NOT db:push). Idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "retailer_terms_acceptances" (
  "id" text PRIMARY KEY NOT NULL,
  "store_id" text NOT NULL REFERENCES "retailer_stores"("id") ON DELETE cascade,
  "accepted_by_account_id" text NOT NULL,
  "terms_version" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retailer_terms_acceptances_store_version_idx" ON "retailer_terms_acceptances" ("store_id","terms_version");
