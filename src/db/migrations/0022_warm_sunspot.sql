ALTER TABLE "orders" ADD COLUMN "platform_fee_override_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "platform_fee_override_reason" text;