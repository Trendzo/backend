ALTER TABLE "retailer_accounts" ADD COLUMN "permanent_suspend" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retailer_accounts" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "retailer_accounts" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retailer_accounts" ADD COLUMN "suspended_by_account_id" text;--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "permanent_suspend" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retailer_stores" ADD COLUMN "suspended_by_account_id" text;