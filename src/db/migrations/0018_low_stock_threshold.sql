ALTER TABLE "retailer_stores" ADD COLUMN IF NOT EXISTS "low_stock_threshold" integer NOT NULL DEFAULT 5;
