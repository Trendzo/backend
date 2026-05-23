ALTER TABLE "variants" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retailer_applications" ADD COLUMN "store_name" text;--> statement-breakpoint
ALTER TABLE "retailer_applications" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "listing_moderation_flags" ADD COLUMN "assigned_admin_id" text;