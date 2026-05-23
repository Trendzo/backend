ALTER TABLE "addresses" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_groups" ADD COLUMN "combined_total_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tcs_rate_bp_snap" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_code" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tcs_rate_bp_snap" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_consumer_default_idx" ON "addresses" USING btree ("consumer_id") WHERE "addresses"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_pickup_code_active_idx" ON "orders" USING btree ("store_id","pickup_code") WHERE "orders"."pickup_code" IS NOT NULL AND "orders"."status" NOT IN ('cancelled','delivered','closed');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pickup_code_method_guard" CHECK ("orders"."pickup_code" IS NULL OR "orders"."delivery_method" = 'pickup');--> statement-breakpoint
-- Backfill order_groups.combined_total_paise from the sum of child orders' grand_total_paise.
-- New groups (single-store today) will have the same total as their one child order.
UPDATE "order_groups" AS og
SET "combined_total_paise" = sub.total
FROM (
  SELECT "group_id", COALESCE(SUM("grand_total_paise"), 0) AS total
  FROM "orders"
  GROUP BY "group_id"
) AS sub
WHERE og.id = sub.group_id;