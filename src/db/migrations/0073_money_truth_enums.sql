-- 0073: New enum labels for the COD cash refund rail, stranded-return withdrawal, and
-- orphaned gateway captures.
--
-- Enum labels MUST land in their own migration. Drizzle wraps each file in one
-- transaction and Postgres refuses to USE a label in the transaction that added it
-- (55P04) — and 0074/0075 use all of these in CHECK predicates and partial-index
-- predicates. Same reason 0069_ban_surface_reels.sql is an enum-only file.

-- Refund destinations. Until now the only rails were 'original_tender' and 'wallet',
-- so a COD refund fell through to a fabricated "succeeded" with no money moved.
--   cash          — physically handed to the consumer (driver pickup or store counter)
--   manual_payout — no automatic rail exists; parked on the admin payout desk
ALTER TYPE "public"."refund_disbursement_destination" ADD VALUE IF NOT EXISTS 'cash';--> statement-breakpoint
ALTER TYPE "public"."refund_disbursement_destination" ADD VALUE IF NOT EXISTS 'manual_payout';--> statement-breakpoint

-- Subtractive driver-cash entry: the driver handed cash back to a consumer, so both
-- his cash-in-hand and his liability to the platform fall.
ALTER TYPE "public"."driver_cash_entry_kind" ADD VALUE IF NOT EXISTS 'refund_paid';--> statement-breakpoint

-- A return closed with no goods movement and no refund: the goods were never collected
-- and the return was abandoned, or it was a duplicate row opened by the pre-0075 race.
ALTER TYPE "public"."store_return_decision" ADD VALUE IF NOT EXISTS 'withdrawn';--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."refund_cash_channel" AS ENUM('driver_reverse_pickup','store_counter');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."gateway_capture_orphan_reason" AS ENUM(
   'already_paid','order_not_awaiting_payment','duplicate_capture',
   'superseded_attempt','order_terminal');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."gateway_capture_orphan_status" AS ENUM(
   'open','refund_initiated','refunded','refund_failed','resolved_manually');
EXCEPTION WHEN duplicate_object THEN null; END $$;
