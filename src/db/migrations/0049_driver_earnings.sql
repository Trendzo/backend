CREATE TABLE IF NOT EXISTS "driver_earnings" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"order_id" text NOT NULL,
	"delivery_method" "delivery_method" NOT NULL,
	"base_paise" integer DEFAULT 0 NOT NULL,
	"incentive_paise" integer DEFAULT 0 NOT NULL,
	"tip_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer DEFAULT 0 NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_earnings" ADD CONSTRAINT "driver_earnings_driver_id_delivery_agents_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_earnings" ADD CONSTRAINT "driver_earnings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_earnings_order_idx" ON "driver_earnings" ("order_id");
