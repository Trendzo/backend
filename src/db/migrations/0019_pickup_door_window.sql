ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_slot_id" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_slot_start" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_slot_end" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "door_window_expires_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "door_window_extended_at" timestamp with time zone;

ALTER TABLE "orders"
  DROP CONSTRAINT IF EXISTS "orders_pickup_slot_method_guard";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_pickup_slot_method_guard"
  CHECK ("pickup_slot_start" IS NULL OR "delivery_method" = 'pickup');
