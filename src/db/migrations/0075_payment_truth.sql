-- 0075: Payment truth + refund idempotency.
--
--  * gateway_capture_orphans — captured money with nowhere to go. Previously a late
--    capture against an already-cancelled order was only console.error'd and the cash
--    sat at the gateway until someone happened to upload a settlement file.
--  * refund_lines_order_item_uniq — an order item may be refunded at most once,
--    globally. Both production writers treat a line as a whole-item refund, and
--    re-refunding after a failure goes through the disbursement retry chain, never a
--    second refund row.
--  * returns_open_per_order_item_uniq — the real serializer for concurrent
--    openReturn calls. The second INSERT blocks on the uncommitted index tuple and
--    then raises 23505; no snapshot race can slip past it.
--  * pickup code attempts/lockout, and the delivered_kept item-outcome backfill.

-- ── Guard rail: refuse to deploy over a materialised double refund ───────────────
-- Duplicate refund LINES mean money already went out twice. Do not silently mangle
-- money records — fail loudly with the offending ids so ops reverses the extra refund
-- through the disbursement desk first, then re-runs this migration.
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(order_item_id, ', ') INTO dup
    FROM (SELECT order_item_id FROM "refund_lines"
           GROUP BY order_item_id HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'refund_lines: duplicate refunds exist for order items: %', dup;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "refund_lines_order_item_uniq"
  ON "refund_lines" ("order_item_id");--> statement-breakpoint

-- ── Collapse duplicate open returns, then make them impossible ───────────────────
-- A PENDING return has by construction never produced a refund (refunds are created
-- only on accept / auto-accept / dispute-resolve), so collapsing duplicates is
-- provably money-safe. They cannot be deleted — held_items, disputes and
-- reverse_pickups.return_ids reference them — so extras are withdrawn, oldest wins.
WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY order_item_id ORDER BY opened_at ASC, id ASC) AS rn
    FROM "returns" WHERE store_decision = 'pending'
)
UPDATE "returns" r
   SET store_decision = 'withdrawn', store_decided_at = now()
  FROM ranked
 WHERE r.id = ranked.id AND ranked.rn > 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "returns_open_per_order_item_uniq"
  ON "returns" ("order_item_id") WHERE "store_decision" = 'pending';--> statement-breakpoint

-- ── Orphaned gateway captures ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gateway_capture_orphans" (
  "id" text PRIMARY KEY NOT NULL,
  "gateway_order_id" text NOT NULL,
  "gateway_payment_id" text NOT NULL,
  "payment_id" text,
  "order_id" text,
  "amount_paise" integer NOT NULL,
  "reason" "gateway_capture_orphan_reason" NOT NULL,
  "status" "gateway_capture_orphan_status" DEFAULT 'open' NOT NULL,
  "gateway_refund_ref" text,
  "failure_message" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by_admin_id" text,
  "resolution_note" text
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "gateway_capture_orphans" ADD CONSTRAINT "gateway_capture_orphans_payment_id_payments_id_fk"
   FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "gateway_capture_orphans" ADD CONSTRAINT "gateway_capture_orphans_order_id_orders_id_fk"
   FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "gateway_capture_orphans" ADD CONSTRAINT "gateway_capture_orphans_resolved_by_admin_id_admin_accounts_id_fk"
   FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Webhook replays are free: the same captured payment can only ever be recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS "gateway_capture_orphans_payment_ref_uniq"
  ON "gateway_capture_orphans" ("gateway_payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_capture_orphans_open_idx"
  ON "gateway_capture_orphans" ("status") WHERE "resolved_at" IS NULL;--> statement-breakpoint

-- ── Pickup code: attempt limiting + lockout ──────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_code_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_code_locked_until" timestamp with time zone;--> statement-breakpoint

-- ── Item outcomes: delivery never stamped one ────────────────────────────────────
-- 'pending_delivery' was tolerated in the returnable set only because no production
-- path ever moved an item out of it. transitionOrder now stamps 'delivered_kept' on
-- delivery; this backfills every order that already shipped.
UPDATE "order_items" oi
   SET "outcome" = 'delivered_kept'
  FROM "orders" o
 WHERE oi."order_id" = o."id"
   AND oi."outcome" = 'pending_delivery'
   AND o."status" IN ('delivered', 'closed');
