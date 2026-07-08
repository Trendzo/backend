-- Lifecycle-sweep bookkeeping on orders:
--   packed_at                  stamped by transitionOrder on →packed (dispatch-rot / pickup-no-show sweeps)
--   agent_assigned_at          when the current driver claimed/was assigned (stale-claim auto-unassign sweep)
--   dispatch_alert_notified_at one-shot dedupe for the unassigned-too-long admin alert
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "packed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "agent_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "dispatch_alert_notified_at" timestamp with time zone;--> statement-breakpoint
-- Backfill packed_at from the audit trail (latest transition into 'packed').
UPDATE "orders" SET "packed_at" = t."at"
FROM (
  SELECT "order_id", max("at") AS "at"
  FROM "order_transitions"
  WHERE "to_status" = 'packed'
  GROUP BY "order_id"
) t
WHERE "orders"."id" = t."order_id" AND "orders"."packed_at" IS NULL;--> statement-breakpoint
-- Start the stale-claim clock at deploy time for already-assigned packed orders.
UPDATE "orders" SET "agent_assigned_at" = now()
WHERE "assigned_agent_id" IS NOT NULL AND "status" = 'packed' AND "agent_assigned_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_packed_sweep_idx" ON "orders" ("packed_at") WHERE "status" = 'packed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_payment_sweep_idx" ON "orders" ("placed_at") WHERE "status" IN ('pending','payment_failed');
