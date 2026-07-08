-- Razorpay two-phase checkout: link pending payment rows to the gateway order
-- created at placement so the verify endpoint / webhook can settle them.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "gateway_order_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_gateway_order_idx" ON "payments" ("gateway_order_id") WHERE "gateway_order_id" IS NOT NULL;
