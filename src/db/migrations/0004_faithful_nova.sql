CREATE TYPE "public"."early_disbursement_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."gst_return_kind" AS ENUM('gstr1', 'gstr3b', 'tcs_reconciliation');--> statement-breakpoint
CREATE TYPE "public"."gst_return_status" AS ENUM('pending', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_reset_cycle" AS ENUM('never', 'fiscal_year', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."post_payout_recovery_status" AS ENUM('planned', 'debited', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."wallet_payout_status" AS ENUM('pending_claim', 'awaiting_bank', 'paid', 'escheated', 'failed');--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"code" text NOT NULL,
	"balance_paise" integer DEFAULT 0 NOT NULL,
	"expires_on" date NOT NULL,
	"issued_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_balance_non_negative" CHECK ("gift_cards"."balance_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"balance_paise" integer NOT NULL,
	"status" "wallet_payout_status" DEFAULT 'pending_claim' NOT NULL,
	"claim_window_ends_at" timestamp with time zone NOT NULL,
	"bank_account_ref" text,
	"disbursed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "early_disbursement_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "early_disbursement_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" text,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "gst_return_files" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"kind" "gst_return_kind" NOT NULL,
	"status" "gst_return_status" DEFAULT 'pending' NOT NULL,
	"download_url" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_numbering_rules" (
	"legal_entity_id" text PRIMARY KEY NOT NULL,
	"legal_entity_name" text NOT NULL,
	"prefix" text DEFAULT 'INV' NOT NULL,
	"pattern" text DEFAULT '{PREFIX}-{YYYY}-{SEQ}' NOT NULL,
	"reset_cycle" "invoice_reset_cycle" DEFAULT 'fiscal_year' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_payout_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"refund_id" text NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"payout_cycle_id" text,
	"refunded_paise" integer NOT NULL,
	"planned_debit_paise" integer NOT NULL,
	"status" "post_payout_recovery_status" DEFAULT 'planned' NOT NULL,
	"reason" text,
	"scheduled_for" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retailer_stores" ALTER COLUMN "handling_fee_paise" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "retailer_stores" ALTER COLUMN "handling_fee_paise" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retailer_stores" ALTER COLUMN "convenience_fee_paise" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "retailer_stores" ALTER COLUMN "convenience_fee_paise" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "delegation_mode_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_payouts" ADD CONSTRAINT "wallet_payouts_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_disbursement_requests" ADD CONSTRAINT "early_disbursement_requests_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_payout_recoveries" ADD CONSTRAINT "post_payout_recoveries_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_payout_recoveries" ADD CONSTRAINT "post_payout_recoveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_payout_recoveries" ADD CONSTRAINT "post_payout_recoveries_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_payout_recoveries" ADD CONSTRAINT "post_payout_recoveries_payout_cycle_id_payouts_id_fk" FOREIGN KEY ("payout_cycle_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_idx" ON "gift_cards" USING btree ("code");--> statement-breakpoint
CREATE INDEX "gift_cards_consumer_idx" ON "gift_cards" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "wallet_payouts_consumer_idx" ON "wallet_payouts" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "wallet_payouts_status_idx" ON "wallet_payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "early_disbursement_requests_store_status_idx" ON "early_disbursement_requests" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "gst_return_files_period_kind_idx" ON "gst_return_files" USING btree ("period","kind");--> statement-breakpoint
CREATE INDEX "post_payout_recoveries_store_status_idx" ON "post_payout_recoveries" USING btree ("store_id","status");