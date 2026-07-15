-- Reels: consumer-authored short fashion videos (Cloudinary-hosted, metadata here) with a
-- social layer (likes / saves / comments) and the community-style takedown/restore model.
-- Schema lived in src/db/schema/reels.ts but was never migrated (tests use drizzle-kit push);
-- this backfills the four tables + two enums so `drizzle-kit migrate` matches the schema.
DO $$ BEGIN
 CREATE TYPE "public"."reel_status" AS ENUM('active','taken_down','hidden_pending_review');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."reel_comment_status" AS ENUM('active','taken_down','hidden_pending_review');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reels" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"caption" text,
	"video_url" text NOT NULL,
	"video_public_id" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"duration_sec" integer,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"product_id" text,
	"status" "reel_status" DEFAULT 'active' NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"save_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"takedown_reason" text,
	"takedown_by_admin_id" text,
	"takedown_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reels_counters_guard" CHECK ("like_count" >= 0 AND "comment_count" >= 0 AND "save_count" >= 0 AND "view_count" >= 0),
	CONSTRAINT "reels_takedown_guard" CHECK (("status" <> 'taken_down' AND "takedown_reason" IS NULL AND "takedown_by_admin_id" IS NULL AND "takedown_at" IS NULL) OR ("status" = 'taken_down' AND "takedown_reason" IS NOT NULL AND "takedown_by_admin_id" IS NOT NULL AND "takedown_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reels" ADD CONSTRAINT "reels_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reels" ADD CONSTRAINT "reels_product_id_product_listings_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product_listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reels" ADD CONSTRAINT "reels_takedown_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("takedown_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reels_status_created_idx" ON "reels" ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reels_consumer_created_idx" ON "reels" ("consumer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reels_product_idx" ON "reels" ("product_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reel_likes" (
	"id" text PRIMARY KEY NOT NULL,
	"reel_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_likes" ADD CONSTRAINT "reel_likes_reel_id_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."reels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_likes" ADD CONSTRAINT "reel_likes_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reel_likes_reel_consumer_uniq" ON "reel_likes" ("reel_id","consumer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reel_likes_consumer_created_idx" ON "reel_likes" ("consumer_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reel_saves" (
	"id" text PRIMARY KEY NOT NULL,
	"reel_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_saves" ADD CONSTRAINT "reel_saves_reel_id_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."reels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_saves" ADD CONSTRAINT "reel_saves_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reel_saves_reel_consumer_uniq" ON "reel_saves" ("reel_id","consumer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reel_saves_consumer_created_idx" ON "reel_saves" ("consumer_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reel_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"reel_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"body" text NOT NULL,
	"status" "reel_comment_status" DEFAULT 'active' NOT NULL,
	"takedown_reason" text,
	"takedown_by_admin_id" text,
	"takedown_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reel_comments_takedown_guard" CHECK (("status" <> 'taken_down' AND "takedown_reason" IS NULL AND "takedown_by_admin_id" IS NULL AND "takedown_at" IS NULL) OR ("status" = 'taken_down' AND "takedown_reason" IS NOT NULL AND "takedown_by_admin_id" IS NOT NULL AND "takedown_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_reel_id_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."reels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_takedown_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("takedown_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reel_comments_reel_created_idx" ON "reel_comments" ("reel_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reel_comments_consumer_created_idx" ON "reel_comments" ("consumer_id","created_at");
