CREATE TYPE "public"."return_reason_category" AS ENUM('damaged', 'wrong_item', 'not_as_described', 'doesnt_fit', 'other');--> statement-breakpoint
CREATE TABLE "store_pickup_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_pickup_slots_day_guard" CHECK ("store_pickup_slots"."day_of_week" >= 0 AND "store_pickup_slots"."day_of_week" <= 6),
	CONSTRAINT "store_pickup_slots_capacity_guard" CHECK ("store_pickup_slots"."capacity" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "acceptance_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "routing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "routing_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_voided_after_return" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "reason_category" "return_reason_category";--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "consumer_photos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "store_pickup_slots" ADD CONSTRAINT "store_pickup_slots_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_pickup_slots_store_day_slot_idx" ON "store_pickup_slots" USING btree ("store_id","day_of_week","start_time");