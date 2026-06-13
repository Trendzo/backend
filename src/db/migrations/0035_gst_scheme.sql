CREATE TYPE "public"."gst_scheme" AS ENUM('regular', 'composition');--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "gst_scheme" "gst_scheme" DEFAULT 'regular' NOT NULL;