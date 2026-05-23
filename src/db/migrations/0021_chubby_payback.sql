ALTER TABLE "held_items" ADD COLUMN "warning_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "store_reject_photos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "held_items_warning_sweep_idx" ON "held_items" USING btree ("status","holding_window_expires_at") WHERE "held_items"."warning_notified_at" IS NULL;