CREATE TABLE IF NOT EXISTS product_chat_sessions (
  id text PRIMARY KEY,
  retailer_id text NOT NULL REFERENCES retailer_accounts(id),
  store_id text NOT NULL REFERENCES retailer_stores(id),
  listing_id text REFERENCES product_listings(id) ON DELETE SET NULL,
  mockup_job_id text REFERENCES bulk_mockup_jobs(id) ON DELETE SET NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_chat_sessions_owner_idx ON product_chat_sessions(retailer_id, updated_at);
