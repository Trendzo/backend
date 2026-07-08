-- Driver COD cash accounting: append-only ledger (collected/deposited) +
-- deposit workflow (pending → confirmed/rejected by admin).
DO $$ BEGIN
 CREATE TYPE "public"."driver_cash_entry_kind" AS ENUM('collected','deposited');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."driver_cash_deposit_status" AS ENUM('pending','confirmed','rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_cash_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"entry_kind" "driver_cash_entry_kind" NOT NULL,
	"amount_paise" integer NOT NULL,
	"order_id" text,
	"deposit_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_cash_ledger" ADD CONSTRAINT "driver_cash_ledger_driver_id_delivery_agents_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_cash_ledger" ADD CONSTRAINT "driver_cash_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_cash_ledger_driver_idx" ON "driver_cash_ledger" ("driver_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_cash_ledger_collected_order_idx" ON "driver_cash_ledger" ("order_id") WHERE "entry_kind" = 'collected' AND "order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_cash_ledger_deposit_idx" ON "driver_cash_ledger" ("deposit_id") WHERE "entry_kind" = 'deposited' AND "deposit_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_cash_deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" "driver_cash_deposit_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"decided_by_admin_id" text,
	"decided_at" timestamp with time zone,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_cash_deposits" ADD CONSTRAINT "driver_cash_deposits_driver_id_delivery_agents_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_cash_deposits" ADD CONSTRAINT "driver_cash_deposits_decided_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_cash_deposits_driver_status_idx" ON "driver_cash_deposits" ("driver_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_cash_deposits_status_idx" ON "driver_cash_deposits" ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_cash_deposits_pending_idx" ON "driver_cash_deposits" ("driver_id") WHERE "status" = 'pending';
