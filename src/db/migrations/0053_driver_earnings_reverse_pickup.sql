-- Reverse-pickup driver earnings: 'reverse_pickup' leg type + per-task idempotency.
-- The old full UNIQUE(order_id) would silently swallow the reverse leg (same order
-- as the forward delivery) — split into two partial uniques so both legs coexist.
ALTER TYPE "public"."delivery_method" ADD VALUE IF NOT EXISTS 'reverse_pickup';--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN IF NOT EXISTS "reverse_pickup_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_earnings" ADD CONSTRAINT "driver_earnings_reverse_pickup_id_reverse_pickups_id_fk" FOREIGN KEY ("reverse_pickup_id") REFERENCES "public"."reverse_pickups"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "driver_earnings_order_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_earnings_order_idx" ON "driver_earnings" ("order_id") WHERE "reverse_pickup_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_earnings_reverse_pickup_idx" ON "driver_earnings" ("reverse_pickup_id") WHERE "reverse_pickup_id" IS NOT NULL;
