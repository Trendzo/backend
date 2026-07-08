-- Reverse pickup: driver collects a consumer-initiated standard return from the
-- customer's home and carries it to the store. Task table + per-driver offer
-- rejections (broadcast model mirrors forward driver offers).
DO $$ BEGIN
 CREATE TYPE "public"."reverse_pickup_status" AS ENUM('pending','assigned','collected','delivered_to_store','cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reverse_pickups" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"return_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consumer_id" text NOT NULL,
	"store_id" text NOT NULL,
	"assigned_driver_id" text,
	"status" "reverse_pickup_status" DEFAULT 'pending' NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"address_city" text,
	"address_pincode" text,
	"address_lat" double precision,
	"address_lng" double precision,
	"items_label" text NOT NULL,
	"collect_otp" text NOT NULL,
	"collected_photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "reverse_pickups_assigned_guard" CHECK ("status" NOT IN ('assigned','collected') OR "assigned_driver_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reverse_pickups" ADD CONSTRAINT "reverse_pickups_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reverse_pickups" ADD CONSTRAINT "reverse_pickups_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reverse_pickups" ADD CONSTRAINT "reverse_pickups_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reverse_pickups" ADD CONSTRAINT "reverse_pickups_assigned_driver_id_delivery_agents_id_fk" FOREIGN KEY ("assigned_driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_pickups_pool_idx" ON "reverse_pickups" ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_pickups_driver_idx" ON "reverse_pickups" ("assigned_driver_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_pickups_store_idx" ON "reverse_pickups" ("store_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_pickups_consumer_idx" ON "reverse_pickups" ("consumer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_pickups_order_idx" ON "reverse_pickups" ("order_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reverse_pickup_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"reverse_pickup_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reverse_pickup_rejections" ADD CONSTRAINT "reverse_pickup_rejections_driver_id_delivery_agents_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reverse_pickup_rejections" ADD CONSTRAINT "reverse_pickup_rejections_reverse_pickup_id_reverse_pickups_id_fk" FOREIGN KEY ("reverse_pickup_id") REFERENCES "public"."reverse_pickups"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reverse_pickup_rejections_driver_task_idx" ON "reverse_pickup_rejections" ("driver_id","reverse_pickup_id");
