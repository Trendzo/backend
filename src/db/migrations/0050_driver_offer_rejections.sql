CREATE TABLE IF NOT EXISTS "driver_offer_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"order_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_offer_rejections" ADD CONSTRAINT "driver_offer_rejections_driver_id_delivery_agents_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_offer_rejections" ADD CONSTRAINT "driver_offer_rejections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_offer_rejections_driver_order_idx" ON "driver_offer_rejections" ("driver_id","order_id");
