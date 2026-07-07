ALTER TABLE "orders" ADD COLUMN "cod_collected_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD COLUMN "signature_url" text;
