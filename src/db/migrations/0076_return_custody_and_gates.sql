-- 0076: Split custody from deadline on returns, anchor the return leg on orders, and
-- make a pickup order incapable of holding a driver.
--
-- `returns.verification_window_expires_at` was doing two jobs — "the goods are at the
-- store" AND "the store's decision clock is running". Because it was one nullable
-- column, a return with no clock was indistinguishable from a return with no goods, so
-- every sweep keyed off it was blind to both: an uncollected reverse pickup stranded
-- the return (and the refund) forever, and a store could accept + restock + refund
-- goods still sitting in the customer's house.
--
--   goods_received_at            → custody. The goods are at the store, now.
--   verification_window_expires_at → the store's decision deadline.
--
-- Invariant (CHECK below): a decision clock may only run once custody is a fact.

ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "goods_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "prior_item_outcome" "order_item_outcome";--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "stuck_alert_notified_at" timestamp with time zone;--> statement-breakpoint

-- Backfill custody. A decided return had its goods handled; a pending return with an
-- armed window had them at the counter. Rows still in flight (parent order is
-- returning_to_store) and rejected_at_door rows (goods stayed with the customer) must
-- stay NULL — asserting custody for those would let the verify sweep refund goods that
-- were never received.
UPDATE "returns" r
   SET "goods_received_at" = COALESCE(r."store_decided_at", r."opened_at")
 WHERE r."goods_received_at" IS NULL
   AND r."store_decision" <> 'rejected_at_door'
   AND (r."store_decided_at" IS NOT NULL OR r."verification_window_expires_at" IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM "order_items" oi JOIN "orders" o ON o.id = oi.order_id
      WHERE oi.id = r."order_item_id" AND o.status = 'returning_to_store');--> statement-breakpoint

-- A return still in flight must not carry a decision clock.
UPDATE "returns" SET "verification_window_expires_at" = NULL
 WHERE "goods_received_at" IS NULL AND "verification_window_expires_at" IS NOT NULL;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "returns" ADD CONSTRAINT "returns_window_requires_custody_guard"
   CHECK ("verification_window_expires_at" IS NULL OR "goods_received_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- The verify sweep now keys off custody rather than return kind, so door returns are
-- covered too; these back it and the two new stuck-state sweeps.
CREATE INDEX IF NOT EXISTS "returns_verify_window_sweep_idx"
  ON "returns" ("verification_window_expires_at")
  WHERE "store_decision" = 'pending' AND "goods_received_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_stranded_sweep_idx"
  ON "returns" ("opened_at")
  WHERE "store_decision" = 'pending' AND "goods_received_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_accepted_sweep_idx"
  ON "returns" ("store_decided_at")
  WHERE "store_decision" = 'accepted' AND "stuck_alert_notified_at" IS NULL;--> statement-breakpoint

-- ── Reverse pickups: one-shot rot alert ──────────────────────────────────────────
ALTER TABLE "reverse_pickups" ADD COLUMN IF NOT EXISTS "stale_alert_notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_pickups_stale_sweep_idx"
  ON "reverse_pickups" ("status","created_at")
  WHERE "status" IN ('pending','assigned','collected');--> statement-breakpoint

-- ── Orders: return-leg anchor + one-shot alert + sweep indexes ───────────────────
-- Indexable, unlike deriving the timestamp from order_transitions on every sweep tick.
-- Same precedent as packed_at, which was added for the dispatch-rot sweep.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "returning_to_store_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "return_leg_alert_notified_at" timestamp with time zone;--> statement-breakpoint

UPDATE "orders" o
   SET "returning_to_store_at" = t.at
  FROM (SELECT order_id, max(at) AS at FROM "order_transitions"
         WHERE to_status = 'returning_to_store' GROUP BY order_id) t
 WHERE t.order_id = o.id AND o."returning_to_store_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "orders_return_leg_sweep_idx"
  ON "orders" ("returning_to_store_at")
  WHERE "status" = 'returning_to_store' AND "return_leg_alert_notified_at" IS NULL;--> statement-breakpoint

-- sweepAutoCloseDelivered has scanned unindexed since it shipped.
CREATE INDEX IF NOT EXISTS "orders_delivered_sweep_idx"
  ON "orders" ("delivered_at") WHERE "status" = 'delivered';--> statement-breakpoint

-- ── A pickup order can never hold a driver ───────────────────────────────────────
-- Pickup orders park in 'packed' for days waiting for the customer, which is exactly
-- the driver-offer predicate, so drivers could claim them and silently convert an
-- in-store collection into a courier delivery.
UPDATE "orders"
   SET "assigned_agent_id" = NULL, "agent_handoff_code" = NULL, "agent_assigned_at" = NULL
 WHERE "delivery_method" = 'pickup' AND "assigned_agent_id" IS NOT NULL;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_pickup_no_agent_guard"
   CHECK ("assigned_agent_id" IS NULL OR "delivery_method" <> 'pickup');
EXCEPTION WHEN duplicate_object THEN null; END $$;
