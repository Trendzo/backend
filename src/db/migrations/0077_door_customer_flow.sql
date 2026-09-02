-- 0077: Customer-driven Try-and-Buy door flow.
--
-- The keep/return decision moves from the driver to the CUSTOMER. During the try-on
-- window (order sits at `at_door`) the consumer app records a per-item choice; when the
-- customer requests a return, the driver app records an accept/reject response. These
-- are IN-FLIGHT staging columns on `order_items` — the final `order_item_outcome` is
-- still written only when the door visit closes (`closeDoor`), so refund / returnable /
-- verification logic that reads `at_door_*` outcomes is untouched.
--
-- Kept off the `returns` table on purpose: a pre-accept `returns` row would trip the
-- door-disposition guard, the one-pending-per-item unique index, and — worst — the
-- stranded-return sweep (store_decision='pending' AND goods_received_at IS NULL), which
-- would flag goods still on the customer's body as a stuck return.

CREATE TYPE "door_customer_choice" AS ENUM ('keep', 'return');--> statement-breakpoint
CREATE TYPE "door_agent_decision" AS ENUM ('accept_return', 'reject_return');--> statement-breakpoint

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "customer_door_choice" "door_customer_choice";--> statement-breakpoint
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "customer_choice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "agent_door_decision" "door_agent_decision";--> statement-breakpoint
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "agent_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "agent_return_reason" text;--> statement-breakpoint
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "agent_return_photos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- An agent decision only exists after the customer requested a return.
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_agent_decision_requires_return_guard"
    CHECK ("agent_door_decision" IS NULL OR "customer_door_choice" = 'return');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Rejecting a return at the door must carry evidence (reason ≥3 chars + ≥1 photo).
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_reject_requires_evidence_guard"
    CHECK ("agent_door_decision" <> 'reject_return'
           OR (length(coalesce("agent_return_reason", '')) >= 3
               AND jsonb_array_length("agent_return_photos") >= 1));
EXCEPTION WHEN duplicate_object THEN null; END $$;
