CREATE TABLE "consumer_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"created_by_admin_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_admin_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_note" text
);
--> statement-breakpoint
CREATE TABLE "promotion_consumer_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"promotion_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"assigned_by_admin_id" text,
	"source" text DEFAULT 'targeted_drop' NOT NULL,
	"voucher_code_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targeted_drops" (
	"id" text PRIMARY KEY NOT NULL,
	"promotion_id" text NOT NULL,
	"cohort_kind" text NOT NULL,
	"audience_size" integer DEFAULT 0 NOT NULL,
	"pushed_by_admin_id" text,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consumer_flags" ADD CONSTRAINT "consumer_flags_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_consumer_grants" ADD CONSTRAINT "promotion_consumer_grants_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_consumer_grants" ADD CONSTRAINT "promotion_consumer_grants_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_consumer_grants" ADD CONSTRAINT "promotion_consumer_grants_voucher_code_id_voucher_codes_id_fk" FOREIGN KEY ("voucher_code_id") REFERENCES "public"."voucher_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targeted_drops" ADD CONSTRAINT "targeted_drops_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consumer_flags_consumer_idx" ON "consumer_flags" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "consumer_flags_open_idx" ON "consumer_flags" USING btree ("consumer_id") WHERE "consumer_flags"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_consumer_grants_pc_idx" ON "promotion_consumer_grants" USING btree ("promotion_id","consumer_id");--> statement-breakpoint
CREATE INDEX "promotion_consumer_grants_consumer_idx" ON "promotion_consumer_grants" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "targeted_drops_promotion_idx" ON "targeted_drops" USING btree ("promotion_id");--> statement-breakpoint
CREATE INDEX "targeted_drops_pushed_at_idx" ON "targeted_drops" USING btree ("pushed_at");