CREATE TYPE "public"."payment_recon_discrepancy_kind" AS ENUM('amount_mismatch', 'missing_in_capture', 'missing_in_settlement', 'status_mismatch', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."payment_settlement_entry_match_status" AS ENUM('pending', 'matched', 'amount_mismatch', 'missing_in_capture', 'status_mismatch', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."payment_settlement_status" AS ENUM('uploaded', 'reconciled', 'partial', 'closed');--> statement-breakpoint
CREATE TABLE "payment_recon_discrepancies" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_id" text NOT NULL,
	"payment_id" text,
	"entry_id" text,
	"kind" "payment_recon_discrepancy_kind" NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_admin_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_note" text
);
--> statement-breakpoint
CREATE TABLE "payment_settlement_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_id" text NOT NULL,
	"gateway_ref" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"tx_at" timestamp with time zone NOT NULL,
	"matched_payment_id" text,
	"match_status" "payment_settlement_entry_match_status" DEFAULT 'pending' NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "payment_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"gateway_name" text NOT NULL,
	"cycle_start" timestamp with time zone NOT NULL,
	"cycle_end" timestamp with time zone NOT NULL,
	"file_ref" text,
	"uploaded_by_admin_id" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "payment_settlement_status" DEFAULT 'uploaded' NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "payment_settlements_cycle_window_guard" CHECK ("payment_settlements"."cycle_end" > "payment_settlements"."cycle_start")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "consumer_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "consumer_notified_by_admin_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "inventory_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "inventory_released_by_admin_id" text;--> statement-breakpoint
ALTER TABLE "payment_recon_discrepancies" ADD CONSTRAINT "payment_recon_discrepancies_settlement_id_payment_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."payment_settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recon_discrepancies" ADD CONSTRAINT "payment_recon_discrepancies_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recon_discrepancies" ADD CONSTRAINT "payment_recon_discrepancies_entry_id_payment_settlement_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."payment_settlement_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlement_entries" ADD CONSTRAINT "payment_settlement_entries_settlement_id_payment_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."payment_settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settlement_entries" ADD CONSTRAINT "payment_settlement_entries_matched_payment_id_payments_id_fk" FOREIGN KEY ("matched_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_recon_discrepancies_settlement_idx" ON "payment_recon_discrepancies" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "payment_recon_discrepancies_open_idx" ON "payment_recon_discrepancies" USING btree ("settlement_id") WHERE "payment_recon_discrepancies"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_settlement_entries_settlement_idx" ON "payment_settlement_entries" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "payment_settlement_entries_gateway_ref_idx" ON "payment_settlement_entries" USING btree ("gateway_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_settlement_entries_unique_ref" ON "payment_settlement_entries" USING btree ("settlement_id","gateway_ref");--> statement-breakpoint
CREATE INDEX "payment_settlements_cycle_idx" ON "payment_settlements" USING btree ("cycle_start","cycle_end");--> statement-breakpoint
CREATE INDEX "payment_settlements_status_idx" ON "payment_settlements" USING btree ("status");