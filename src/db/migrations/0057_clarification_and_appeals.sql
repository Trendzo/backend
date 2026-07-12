-- Clarification + appeal threads.
--   * application_messages gains field_key — tags a clarification message to the
--     application field/doc it's about (e.g. 'gstin', 'pan'), rendered as a chip.
--   * account_appeal_messages — a per-store appeal thread for suspended/terminated
--     stores, so the retailer (who signs in read-only) can appeal and the admin can
--     respond in-band before lifting or upholding the action.
ALTER TABLE "application_messages" ADD COLUMN IF NOT EXISTS "field_key" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_appeal_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_account_id" text,
	"body" text NOT NULL,
	"attachment_urls" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_appeal_messages" ADD CONSTRAINT "account_appeal_messages_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_appeal_messages_store_idx" ON "account_appeal_messages" USING btree ("store_id","at");
