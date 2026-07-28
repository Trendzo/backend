-- 0067: Spin & Win — an admin-configurable prize wheel.
--
-- The wheel owns presentation and throttling only. A winning slice points at an existing
-- `promotions` row, so min-order-value / first-order-only / per-consumer-limit / tier /
-- store-scope / expiry all stay in the one rules engine that already enforces them at
-- quote time. No second discount engine is introduced here.
CREATE TYPE "spin_wheel_status" AS ENUM ('draft', 'active', 'paused', 'archived');
--> statement-breakpoint
CREATE TYPE "spin_reward_kind" AS ENUM ('promotion', 'points', 'none');
--> statement-breakpoint
CREATE TYPE "spin_play_status" AS ENUM ('pending_claim', 'claimed', 'no_prize', 'expired');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spin_wheels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "spin_wheel_status" DEFAULT 'draft' NOT NULL,
	"surface" text DEFAULT 'both' NOT NULL,
	"spins_per_device_per_day" integer DEFAULT 1 NOT NULL,
	"max_claims_per_consumer" integer DEFAULT 1,
	"guest_spin_allowed" boolean DEFAULT true NOT NULL,
	"claim_window_hours" integer DEFAULT 168 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spin_wheels_validity_guard" CHECK ("valid_until" > "valid_from"),
	CONSTRAINT "spin_wheels_throttle_guard" CHECK (
		"spins_per_device_per_day" >= 1
		AND "claim_window_hours" >= 1
		AND ("max_claims_per_consumer" IS NULL OR "max_claims_per_consumer" >= 1)
	)
);
--> statement-breakpoint
-- At most one live wheel, enforced by the database rather than by whoever remembers to
-- pause the old one. Activating a second raises 23505.
CREATE UNIQUE INDEX IF NOT EXISTS "spin_wheels_one_active_idx" ON "spin_wheels" ("status") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spin_wheels_status_validity_idx" ON "spin_wheels" ("status","valid_from","valid_until");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spin_wheel_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"wheel_id" text NOT NULL,
	"sort_order" integer NOT NULL,
	"label" text NOT NULL,
	"sublabel" text,
	"icon" text,
	"color_hex" text,
	"weight_bp" integer NOT NULL,
	"reward_kind" "spin_reward_kind" NOT NULL,
	"promotion_id" text,
	"points" integer,
	"stock_total" integer,
	"stock_issued" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spin_wheel_segments_counters_guard" CHECK (
		"weight_bp" >= 0
		AND "stock_issued" >= 0
		AND ("stock_total" IS NULL OR "stock_total" >= 0)
		AND ("stock_total" IS NULL OR "stock_issued" <= "stock_total")
	),
	CONSTRAINT "spin_wheel_segments_reward_guard" CHECK (
		("reward_kind" = 'promotion' AND "promotion_id" IS NOT NULL AND "points" IS NULL)
		OR ("reward_kind" = 'points' AND "points" > 0 AND "promotion_id" IS NULL)
		OR ("reward_kind" = 'none' AND "promotion_id" IS NULL AND "points" IS NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spin_wheel_segments" ADD CONSTRAINT "spin_wheel_segments_wheel_id_spin_wheels_id_fk" FOREIGN KEY ("wheel_id") REFERENCES "spin_wheels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Restricted, not cascaded: deleting a promotion a live wheel points at should fail loudly
-- rather than silently blank a slice.
DO $$ BEGIN
 ALTER TABLE "spin_wheel_segments" ADD CONSTRAINT "spin_wheel_segments_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spin_wheel_segments_wheel_order_idx" ON "spin_wheel_segments" ("wheel_id","sort_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spin_plays" (
	"id" text PRIMARY KEY NOT NULL,
	"wheel_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"device_id" text NOT NULL,
	"consumer_id" text,
	"status" "spin_play_status" NOT NULL,
	"claim_token" text NOT NULL,
	"claim_expires_at" timestamp with time zone,
	"voucher_code_id" text,
	"points_awarded" integer,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spin_plays" ADD CONSTRAINT "spin_plays_wheel_id_spin_wheels_id_fk" FOREIGN KEY ("wheel_id") REFERENCES "spin_wheels"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spin_plays" ADD CONSTRAINT "spin_plays_segment_id_spin_wheel_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "spin_wheel_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spin_plays" ADD CONSTRAINT "spin_plays_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "consumers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spin_plays" ADD CONSTRAINT "spin_plays_voucher_code_id_voucher_codes_id_fk" FOREIGN KEY ("voucher_code_id") REFERENCES "voucher_codes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Claim is idempotent on this token: a retry over a flaky network returns the same prize
-- instead of minting a second one.
CREATE UNIQUE INDEX IF NOT EXISTS "spin_plays_claim_token_idx" ON "spin_plays" ("claim_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spin_plays_device_played_idx" ON "spin_plays" ("device_id","played_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spin_plays_consumer_idx" ON "spin_plays" ("consumer_id","wheel_id") WHERE "consumer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spin_plays_wheel_played_idx" ON "spin_plays" ("wheel_id","played_at");
