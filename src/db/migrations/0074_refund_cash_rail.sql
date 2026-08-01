-- 0074: The COD cash refund rail.
--
-- A returned COD order collected real cash but its refund took the simulated branch
-- (the source ref is 'COD-…', never a 'pay_…' gateway id), so the customer was told
-- "Refund complete · back on your original payment method" while no money moved.
--
-- Cash is now a first-class disbursement rail settled by an actual handover:
--   * driver hands cash at the reverse-pickup collection, or
--   * the retailer hands cash at the counter, or
--   * neither channel exists → the leg parks 'pending' on the admin payout desk.
--
-- The `settled_proof_guard` CHECK is what makes the old failure structurally
-- impossible: a succeeded non-wallet leg must carry both a timestamp and a reference.

-- Legacy rows first, so the new proof guard cannot block the deploy on historical data.
UPDATE "refund_disbursements" SET "settled_at" = "initiated_at"
 WHERE "status" = 'succeeded' AND "settled_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "refund_cash_handovers" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "return_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "amount_paise" integer NOT NULL,
  "channel" "refund_cash_channel" NOT NULL,
  "reverse_pickup_id" text,
  "driver_id" text,
  "store_id" text,
  "recorded_by_actor_type" "actor_type" NOT NULL,
  "recorded_by_actor_id" text NOT NULL,
  "proof_photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "note" text,
  "handed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_cash_handovers" ADD CONSTRAINT "refund_cash_handovers_order_id_orders_id_fk"
   FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_cash_handovers" ADD CONSTRAINT "refund_cash_handovers_reverse_pickup_id_reverse_pickups_id_fk"
   FOREIGN KEY ("reverse_pickup_id") REFERENCES "public"."reverse_pickups"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_cash_handovers" ADD CONSTRAINT "refund_cash_handovers_driver_id_delivery_agents_id_fk"
   FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_cash_handovers" ADD CONSTRAINT "refund_cash_handovers_store_id_retailer_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_cash_handovers" ADD CONSTRAINT "refund_cash_handovers_amount_positive"
   CHECK ("amount_paise" > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- A handover is exactly one channel, and each channel names exactly its own actor.
DO $$ BEGIN
 ALTER TABLE "refund_cash_handovers" ADD CONSTRAINT "refund_cash_handovers_channel_guard"
   CHECK (
     ("channel" = 'driver_reverse_pickup' AND "reverse_pickup_id" IS NOT NULL
        AND "driver_id" IS NOT NULL AND "store_id" IS NULL)
     OR ("channel" = 'store_counter' AND "store_id" IS NOT NULL
        AND "reverse_pickup_id" IS NULL AND "driver_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- At most one handover per pickup task: a replayed collect cannot pay twice.
CREATE UNIQUE INDEX IF NOT EXISTS "refund_cash_handovers_reverse_pickup_idx"
  ON "refund_cash_handovers" ("reverse_pickup_id") WHERE "reverse_pickup_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_cash_handovers_order_idx"
  ON "refund_cash_handovers" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_cash_handovers_channel_idx"
  ON "refund_cash_handovers" ("channel","handed_at");--> statement-breakpoint

ALTER TABLE "refund_disbursements" ADD COLUMN IF NOT EXISTS "cash_handover_id" text;--> statement-breakpoint
ALTER TABLE "refund_disbursements" ADD COLUMN IF NOT EXISTS "settled_by_actor_type" "actor_type";--> statement-breakpoint
ALTER TABLE "refund_disbursements" ADD COLUMN IF NOT EXISTS "settled_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "refund_disbursements" ADD COLUMN IF NOT EXISTS "settlement_note" text;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_cash_handover_id_refund_cash_handovers_id_fk"
   FOREIGN KEY ("cash_handover_id") REFERENCES "public"."refund_cash_handovers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Postgres cannot ALTER a CHECK in place: drop and re-add with the new rails.
-- Invariant unchanged in spirit — wallet legs never point at a payment; every other
-- rail must name the payment it is refunding.
ALTER TABLE "refund_disbursements" DROP CONSTRAINT IF EXISTS "refund_disbursements_destination_guard";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_destination_guard"
   CHECK (("destination" = 'wallet' AND "source_payment_id" IS NULL)
     OR ("destination" IN ('original_tender','cash','manual_payout') AND "source_payment_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- "Succeeded with nothing behind it" is now refused by the database. Wallet legs are
-- exempt: their proof is the wallet_transactions row, so they legitimately carry no ref.
DO $$ BEGIN
 ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_settled_proof_guard"
   CHECK ("status" <> 'succeeded'
     OR ("settled_at" IS NOT NULL AND ("destination" = 'wallet' OR "gateway_ref" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_cash_handover_guard"
   CHECK ("cash_handover_id" IS NULL OR "destination" = 'cash');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refund_disbursements_payout_desk_idx"
  ON "refund_disbursements" ("destination","initiated_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_disbursements_cash_handover_idx"
  ON "refund_disbursements" ("cash_handover_id") WHERE "cash_handover_id" IS NOT NULL;--> statement-breakpoint
-- Backstop for the refund.failed webhook lookup, so .returning() is provably single-row.
CREATE UNIQUE INDEX IF NOT EXISTS "refund_disbursements_gateway_ref_uniq"
  ON "refund_disbursements" ("gateway_ref") WHERE "gateway_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_disbursements_pending_sweep_idx"
  ON "refund_disbursements" ("initiated_at") WHERE "status" = 'pending';--> statement-breakpoint

-- The pickup task carries the cash the driver must hand over, computed at creation
-- time and capped at what was actually collected on that order.
ALTER TABLE "reverse_pickups" ADD COLUMN IF NOT EXISTS "cash_refund_due_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reverse_pickups" ADD COLUMN IF NOT EXISTS "cash_handed_paise" integer;--> statement-breakpoint
ALTER TABLE "reverse_pickups" ADD COLUMN IF NOT EXISTS "cash_handed_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "reverse_pickups" ADD CONSTRAINT "reverse_pickups_cash_handed_guard"
   CHECK ("cash_handed_paise" IS NULL OR ("cash_handed_at" IS NOT NULL AND "cash_handed_paise" >= 0));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "driver_cash_ledger" ADD COLUMN IF NOT EXISTS "reverse_pickup_id" text;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "driver_cash_ledger" ADD CONSTRAINT "driver_cash_ledger_reverse_pickup_id_reverse_pickups_id_fk"
   FOREIGN KEY ("reverse_pickup_id") REFERENCES "public"."reverse_pickups"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Mirrors the existing collected/deposited partial uniques: one refund payout per task.
CREATE UNIQUE INDEX IF NOT EXISTS "driver_cash_ledger_refund_paid_idx"
  ON "driver_cash_ledger" ("reverse_pickup_id")
  WHERE "entry_kind" = 'refund_paid' AND "reverse_pickup_id" IS NOT NULL;
