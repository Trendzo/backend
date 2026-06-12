CREATE TYPE "public"."awaiting_party" AS ENUM('admin', 'retailer', 'consumer', 'none');--> statement-breakpoint
CREATE TYPE "public"."banner_scope" AS ENUM('all_retailers', 'store', 'all_admins');--> statement-breakpoint
CREATE TYPE "public"."banner_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."billing_statement_status" AS ENUM('open', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."community_post_status" AS ENUM('active', 'taken_down', 'hidden_pending_review');--> statement-breakpoint
CREATE TYPE "public"."consumer_ban_surface" AS ENUM('posts', 'reviews', 'rewards');--> statement-breakpoint
CREATE TYPE "public"."email_outbox_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."issue_kind" AS ENUM('query', 'complaint', 'dispute');--> statement-breakpoint
CREATE TYPE "public"."moderation_action_kind" AS ENUM('approve', 'edit', 'takedown');--> statement-breakpoint
CREATE TYPE "public"."moderation_report_source" AS ENUM('auto', 'user');--> statement-breakpoint
CREATE TYPE "public"."moderation_report_status" AS ENUM('pending', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."moderation_target_type" AS ENUM('community_post', 'product_review');--> statement-breakpoint
CREATE TYPE "public"."payout_adjustment_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."payout_adjustment_kind" AS ENUM('manual', 'dispute_liability');--> statement-breakpoint
CREATE TYPE "public"."payout_hold_status" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."pos_pricing_mode" AS ENUM('tax_inclusive', 'tax_exclusive');--> statement-breakpoint
CREATE TYPE "public"."pos_sale_status" AS ENUM('held', 'completed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."pos_tender_method" AS ENUM('cash', 'card', 'upi');--> statement-breakpoint
CREATE TYPE "public"."product_review_status" AS ENUM('active', 'taken_down', 'hidden_pending_review');--> statement-breakpoint
CREATE TYPE "public"."push_attempt_status" AS ENUM('pending', 'sent', 'failed', 'skipped_disabled');--> statement-breakpoint
CREATE TYPE "public"."push_subscription_platform" AS ENUM('web', 'ios', 'android');--> statement-breakpoint
ALTER TYPE "public"."agent_disposition" ADD VALUE 'return_rejected';--> statement-breakpoint
ALTER TYPE "public"."inventory_adjustment_reason" ADD VALUE 'pos_sale';--> statement-breakpoint
ALTER TYPE "public"."inventory_adjustment_reason" ADD VALUE 'pos_return_restock';--> statement-breakpoint
ALTER TYPE "public"."inventory_adjustment_reason" ADD VALUE 'pos_void_restock';--> statement-breakpoint
ALTER TYPE "public"."invoice_kind" ADD VALUE 'pos_tax_invoice';--> statement-breakpoint
ALTER TYPE "public"."order_item_outcome" ADD VALUE 'at_door_return_rejected' BEFORE 'at_store_pending_verification';--> statement-breakpoint
ALTER TYPE "public"."retailer_sub_role" ADD VALUE 'delivery_agent';--> statement-breakpoint
ALTER TYPE "public"."store_return_decision" ADD VALUE 'rejected_at_door';--> statement-breakpoint
CREATE TABLE "store_media" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"url" text NOT NULL,
	"public_id" text,
	"folder" text,
	"resource_type" text DEFAULT 'image' NOT NULL,
	"mimetype" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"alt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "billing_statements" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"period" text NOT NULL,
	"commission_paise" bigint DEFAULT 0 NOT NULL,
	"commission_tax_paise" bigint DEFAULT 0 NOT NULL,
	"add_on_fees_paise" bigint DEFAULT 0 NOT NULL,
	"tcs_paise" bigint DEFAULT 0 NOT NULL,
	"dispute_liabilities_paise" bigint DEFAULT 0 NOT NULL,
	"adjustments_paise" bigint DEFAULT 0 NOT NULL,
	"net_payout_paise" bigint DEFAULT 0 NOT NULL,
	"pdf_url" text,
	"status" "billing_statement_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"payout_id" text,
	"direction" "payout_adjustment_direction" NOT NULL,
	"kind" "payout_adjustment_kind" DEFAULT 'manual' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"source_issue_id" text,
	"created_by_admin_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"dispute_id" text NOT NULL,
	"payout_id" text,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" "payout_hold_status" DEFAULT 'active' NOT NULL,
	"created_by_admin_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_reason" text
);
--> statement-breakpoint
CREATE TABLE "payout_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"payout_id" text NOT NULL,
	"from_status" "payout_status",
	"to_status" "payout_status" NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_issue_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"sender_type" "support_sender_type" NOT NULL,
	"sender_id" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_issue_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"from_status" "dispute_status",
	"to_status" "dispute_status" NOT NULL,
	"awaiting_party_to" "awaiting_party",
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "issue_kind" NOT NULL,
	"store_id" text NOT NULL,
	"order_id" text,
	"return_id" text,
	"opened_by_actor_type" "actor_type" NOT NULL,
	"opened_by_actor_id" text NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"assigned_admin_id" text,
	"awaiting_party" "awaiting_party" DEFAULT 'admin' NOT NULL,
	"decision" "dispute_decision",
	"decision_note" text,
	"decided_by_admin_id" text,
	"decided_at" timestamp with time zone,
	"payout_adjustment_paise" bigint,
	"linked_hold_id" text,
	"linked_adjustment_id" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "customer_issues_target_present" CHECK ("customer_issues"."order_id" IS NOT NULL OR "customer_issues"."return_id" IS NOT NULL),
	CONSTRAINT "customer_issues_decision_guard" CHECK (("customer_issues"."status" = 'decided'
            AND "customer_issues"."decision" IS NOT NULL
            AND "customer_issues"."decided_at" IS NOT NULL
            AND "customer_issues"."decided_by_admin_id" IS NOT NULL)
        OR ("customer_issues"."status" <> 'decided'
            AND "customer_issues"."decision" IS NULL
            AND "customer_issues"."decided_at" IS NULL
            AND "customer_issues"."decided_by_admin_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"body" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "community_post_status" DEFAULT 'active' NOT NULL,
	"takedown_reason" text,
	"takedown_by_admin_id" text,
	"takedown_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_posts_takedown_guard" CHECK (("community_posts"."status" <> 'taken_down'
            AND "community_posts"."takedown_reason" IS NULL
            AND "community_posts"."takedown_by_admin_id" IS NULL
            AND "community_posts"."takedown_at" IS NULL)
        OR ("community_posts"."status" = 'taken_down'
            AND "community_posts"."takedown_reason" IS NOT NULL
            AND "community_posts"."takedown_by_admin_id" IS NOT NULL
            AND "community_posts"."takedown_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consumer_bans" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"surface" "consumer_ban_surface" NOT NULL,
	"reason" text NOT NULL,
	"created_by_admin_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_by_admin_id" text,
	"lifted_at" timestamp with time zone,
	"lift_reason" text,
	CONSTRAINT "consumer_bans_lift_guard" CHECK (("consumer_bans"."lifted_at" IS NULL AND "consumer_bans"."lifted_by_admin_id" IS NULL)
        OR ("consumer_bans"."lifted_at" IS NOT NULL AND "consumer_bans"."lifted_by_admin_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"target_type" "moderation_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"action" "moderation_action_kind" NOT NULL,
	"admin_id" text NOT NULL,
	"reason" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"report_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"target_type" "moderation_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"reporter_consumer_id" text,
	"source" "moderation_report_source" NOT NULL,
	"reason" text NOT NULL,
	"status" "moderation_report_status" DEFAULT 'pending' NOT NULL,
	"decided_by_admin_id" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_reports_decision_guard" CHECK (("moderation_reports"."status" = 'pending'
            AND "moderation_reports"."decided_by_admin_id" IS NULL
            AND "moderation_reports"."decided_at" IS NULL)
        OR ("moderation_reports"."status" <> 'pending'
            AND "moderation_reports"."decided_by_admin_id" IS NOT NULL
            AND "moderation_reports"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"order_id" text,
	"rating" integer NOT NULL,
	"body" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "product_review_status" DEFAULT 'active' NOT NULL,
	"takedown_reason" text,
	"takedown_by_admin_id" text,
	"takedown_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_reviews_rating_range" CHECK ("product_reviews"."rating" >= 1 AND "product_reviews"."rating" <= 5),
	CONSTRAINT "product_reviews_takedown_guard" CHECK (("product_reviews"."status" <> 'taken_down'
            AND "product_reviews"."takedown_reason" IS NULL
            AND "product_reviews"."takedown_by_admin_id" IS NULL
            AND "product_reviews"."takedown_at" IS NULL)
        OR ("product_reviews"."status" = 'taken_down'
            AND "product_reviews"."takedown_reason" IS NOT NULL
            AND "product_reviews"."takedown_by_admin_id" IS NOT NULL
            AND "product_reviews"."takedown_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cart_events" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"qty" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_events_qty_positive" CHECK ("cart_events"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "listing_views" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text,
	"store_id" text NOT NULL,
	"consumer_id" text,
	"session_id" text,
	"source" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banner_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"banner_id" text NOT NULL,
	"account_kind" "actor_type" NOT NULL,
	"account_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banners" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "banner_scope" NOT NULL,
	"store_id" text,
	"severity" "banner_severity" DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"deep_link" text,
	"dismissible" text DEFAULT 'true' NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_until" timestamp with time zone,
	"created_by_admin_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_kind" "actor_type" NOT NULL,
	"recipient_id" text NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"kind" "notification_kind" DEFAULT 'system' NOT NULL,
	"status" "email_outbox_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "push_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" "push_attempt_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_kind" "actor_type" NOT NULL,
	"recipient_id" text NOT NULL,
	"platform" "push_subscription_platform" NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text,
	"auth" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pos_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text,
	"phone" text,
	"gstin" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"sale_id" text NOT NULL,
	"method" "pos_tender_method" NOT NULL,
	"direction" text DEFAULT 'collect' NOT NULL,
	"amount_paise" integer NOT NULL,
	"tendered_paise" integer,
	"change_paise" integer DEFAULT 0 NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_return_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"return_sale_id" text NOT NULL,
	"original_sale_item_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"qty" integer NOT NULL,
	"refund_paise" integer NOT NULL,
	"restock" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pos_return_lines_qty_guard" CHECK ("pos_return_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sale_items" (
	"id" text PRIMARY KEY NOT NULL,
	"sale_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"listing_name_snap" text NOT NULL,
	"brand_snap" text,
	"category_snap" text,
	"attributes_label_snap" text NOT NULL,
	"hsn_snap" text,
	"sku_snap" text,
	"barcode_snap" text,
	"qty" integer NOT NULL,
	"unit_mrp_paise" integer NOT NULL,
	"line_gross_paise" integer NOT NULL,
	"line_discount_paise" integer DEFAULT 0 NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"taxable_value_paise" integer NOT NULL,
	"gst_paise" integer NOT NULL,
	"net_line_paise" integer NOT NULL,
	CONSTRAINT "pos_sale_items_qty_guard" CHECK ("pos_sale_items"."qty" > 0 AND "pos_sale_items"."unit_mrp_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sales" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"cashier_account_id" text NOT NULL,
	"customer_id" text,
	"status" "pos_sale_status" DEFAULT 'held' NOT NULL,
	"note" text,
	"customer_name_snap" text,
	"customer_phone_snap" text,
	"customer_gstin_snap" text,
	"store_legal_name_snap" text NOT NULL,
	"store_gstin_snap" text NOT NULL,
	"store_state_code_snap" text NOT NULL,
	"store_address_snap" text NOT NULL,
	"tax_split_kind" "tax_split_kind" DEFAULT 'intra_state' NOT NULL,
	"pricing_mode" "pos_pricing_mode" DEFAULT 'tax_inclusive' NOT NULL,
	"items_gross_paise" integer DEFAULT 0 NOT NULL,
	"line_discount_paise" integer DEFAULT 0 NOT NULL,
	"bill_discount_paise" integer DEFAULT 0 NOT NULL,
	"taxable_value_paise" integer DEFAULT 0 NOT NULL,
	"cgst_paise" integer DEFAULT 0 NOT NULL,
	"sgst_paise" integer DEFAULT 0 NOT NULL,
	"igst_paise" integer DEFAULT 0 NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"round_off_paise" integer DEFAULT 0 NOT NULL,
	"payable_paise" integer DEFAULT 0 NOT NULL,
	"tendered_paise" integer DEFAULT 0 NOT NULL,
	"change_paise" integer DEFAULT 0 NOT NULL,
	"invoice_id" text,
	"original_sale_id" text,
	"idempotency_key" text NOT NULL,
	"void_reason" text,
	"held_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sales_gst_split_guard" CHECK (("pos_sales"."tax_split_kind" = 'intra_state' AND "pos_sales"."igst_paise" = 0 AND "pos_sales"."cgst_paise" + "pos_sales"."sgst_paise" = "pos_sales"."tax_paise")
        OR ("pos_sales"."tax_split_kind" = 'inter_state' AND "pos_sales"."cgst_paise" = 0 AND "pos_sales"."sgst_paise" = 0 AND "pos_sales"."igst_paise" = "pos_sales"."tax_paise")),
	CONSTRAINT "pos_sales_tendered_guard" CHECK ("pos_sales"."status" <> 'completed' OR "pos_sales"."tendered_paise" >= "pos_sales"."payable_paise")
);
--> statement-breakpoint
DROP INDEX "variants_listing_sku_idx";--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_listings" ADD COLUMN "description_long" text;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "store_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "compare_at_price" integer;--> statement-breakpoint
ALTER TABLE "attribute_templates" ADD COLUMN "usage_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_templates" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "assigned_agent_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pos_sale_id" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "dispute_hold_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "bank_confirmation_ref" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "bank_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "previous_payout_id" text;--> statement-breakpoint
ALTER TABLE "store_media" ADD CONSTRAINT "store_media_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_holds" ADD CONSTRAINT "payout_holds_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_holds" ADD CONSTRAINT "payout_holds_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_transitions" ADD CONSTRAINT "payout_transitions_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issue_messages" ADD CONSTRAINT "customer_issue_messages_issue_id_customer_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."customer_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issue_transitions" ADD CONSTRAINT "customer_issue_transitions_issue_id_customer_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."customer_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issues" ADD CONSTRAINT "customer_issues_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issues" ADD CONSTRAINT "customer_issues_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issues" ADD CONSTRAINT "customer_issues_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issues" ADD CONSTRAINT "customer_issues_assigned_admin_id_admin_accounts_id_fk" FOREIGN KEY ("assigned_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issues" ADD CONSTRAINT "customer_issues_decided_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_takedown_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("takedown_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_bans" ADD CONSTRAINT "consumer_bans_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_bans" ADD CONSTRAINT "consumer_bans_created_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_bans" ADD CONSTRAINT "consumer_bans_lifted_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("lifted_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_admin_id_admin_accounts_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_moderation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."moderation_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reporter_consumer_id_consumers_id_fk" FOREIGN KEY ("reporter_consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_decided_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_takedown_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("takedown_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_events" ADD CONSTRAINT "cart_events_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_events" ADD CONSTRAINT "cart_events_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_events" ADD CONSTRAINT "cart_events_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_events" ADD CONSTRAINT "cart_events_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_views" ADD CONSTRAINT "listing_views_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_views" ADD CONSTRAINT "listing_views_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_views" ADD CONSTRAINT "listing_views_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_views" ADD CONSTRAINT "listing_views_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banner_dismissals" ADD CONSTRAINT "banner_dismissals_banner_id_banners_id_fk" FOREIGN KEY ("banner_id") REFERENCES "public"."banners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_attempts" ADD CONSTRAINT "push_attempts_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_attempts" ADD CONSTRAINT "push_attempts_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_customers" ADD CONSTRAINT "pos_customers_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_sale_id_pos_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_return_sale_id_pos_sales_id_fk" FOREIGN KEY ("return_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_original_sale_item_id_pos_sale_items_id_fk" FOREIGN KEY ("original_sale_item_id") REFERENCES "public"."pos_sale_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_items" ADD CONSTRAINT "pos_sale_items_sale_id_pos_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_items" ADD CONSTRAINT "pos_sale_items_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_items" ADD CONSTRAINT "pos_sale_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_cashier_account_id_retailer_accounts_id_fk" FOREIGN KEY ("cashier_account_id") REFERENCES "public"."retailer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_customer_id_pos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."pos_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_media_store_created_idx" ON "store_media" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_statements_store_period_unique" ON "billing_statements" USING btree ("store_id","period");--> statement-breakpoint
CREATE INDEX "payout_adjustments_store_payout_idx" ON "payout_adjustments" USING btree ("store_id","payout_id");--> statement-breakpoint
CREATE INDEX "payout_adjustments_kind_idx" ON "payout_adjustments" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "payout_holds_store_status_idx" ON "payout_holds" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "payout_holds_dispute_idx" ON "payout_holds" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "payout_transitions_payout_at_idx" ON "payout_transitions" USING btree ("payout_id","at");--> statement-breakpoint
CREATE INDEX "customer_issue_messages_issue_at_idx" ON "customer_issue_messages" USING btree ("issue_id","at");--> statement-breakpoint
CREATE INDEX "customer_issue_transitions_issue_at_idx" ON "customer_issue_transitions" USING btree ("issue_id","at");--> statement-breakpoint
CREATE INDEX "customer_issues_store_status_idx" ON "customer_issues" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "customer_issues_opener_idx" ON "customer_issues" USING btree ("opened_by_actor_type","opened_by_actor_id");--> statement-breakpoint
CREATE INDEX "customer_issues_awaiting_idx" ON "customer_issues" USING btree ("awaiting_party");--> statement-breakpoint
CREATE INDEX "customer_issues_order_idx" ON "customer_issues" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "customer_issues_return_idx" ON "customer_issues" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "community_posts_consumer_created_idx" ON "community_posts" USING btree ("consumer_id","created_at");--> statement-breakpoint
CREATE INDEX "community_posts_status_idx" ON "community_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "consumer_bans_consumer_idx" ON "consumer_bans" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "consumer_bans_surface_idx" ON "consumer_bans" USING btree ("surface");--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_bans_active_uniq" ON "consumer_bans" USING btree ("consumer_id","surface") WHERE "consumer_bans"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "moderation_actions_target_at_idx" ON "moderation_actions" USING btree ("target_type","target_id","at");--> statement-breakpoint
CREATE INDEX "moderation_actions_admin_at_idx" ON "moderation_actions" USING btree ("admin_id","at");--> statement-breakpoint
CREATE INDEX "moderation_reports_status_created_idx" ON "moderation_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "moderation_reports_target_idx" ON "moderation_reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "product_reviews_listing_created_idx" ON "product_reviews" USING btree ("listing_id","created_at");--> statement-breakpoint
CREATE INDEX "product_reviews_consumer_created_idx" ON "product_reviews" USING btree ("consumer_id","created_at");--> statement-breakpoint
CREATE INDEX "product_reviews_status_idx" ON "product_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cart_events_store_at_idx" ON "cart_events" USING btree ("store_id","at");--> statement-breakpoint
CREATE INDEX "cart_events_listing_at_idx" ON "cart_events" USING btree ("listing_id","at");--> statement-breakpoint
CREATE INDEX "cart_events_variant_at_idx" ON "cart_events" USING btree ("variant_id","at");--> statement-breakpoint
CREATE INDEX "listing_views_store_at_idx" ON "listing_views" USING btree ("store_id","at");--> statement-breakpoint
CREATE INDEX "listing_views_listing_at_idx" ON "listing_views" USING btree ("listing_id","at");--> statement-breakpoint
CREATE INDEX "listing_views_variant_at_idx" ON "listing_views" USING btree ("variant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "banner_dismissals_banner_account_uniq" ON "banner_dismissals" USING btree ("banner_id","account_kind","account_id");--> statement-breakpoint
CREATE INDEX "banners_scope_active_idx" ON "banners" USING btree ("scope","active_from");--> statement-breakpoint
CREATE INDEX "banners_store_idx" ON "banners" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "email_outbox_recipient_idx" ON "email_outbox" USING btree ("recipient_kind","recipient_id");--> statement-breakpoint
CREATE INDEX "email_outbox_status_idx" ON "email_outbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX "push_attempts_notification_idx" ON "push_attempts" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "push_attempts_sub_at_idx" ON "push_attempts" USING btree ("subscription_id","attempted_at");--> statement-breakpoint
CREATE INDEX "push_subscriptions_recipient_idx" ON "push_subscriptions" USING btree ("recipient_kind","recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_active_uniq" ON "push_subscriptions" USING btree ("endpoint") WHERE "push_subscriptions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pos_customers_store_phone_idx" ON "pos_customers" USING btree ("store_id","phone");--> statement-breakpoint
CREATE INDEX "pos_payments_sale_idx" ON "pos_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pos_return_lines_return_sale_idx" ON "pos_return_lines" USING btree ("return_sale_id");--> statement-breakpoint
CREATE INDEX "pos_sale_items_sale_idx" ON "pos_sale_items" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pos_sale_items_variant_idx" ON "pos_sale_items" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_idempotency_idx" ON "pos_sales" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "pos_sales_store_status_created_idx" ON "pos_sales" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "pos_sales_store_completed_idx" ON "pos_sales" USING btree ("store_id","completed_at");--> statement-breakpoint
CREATE INDEX "pos_sales_cashier_idx" ON "pos_sales" USING btree ("cashier_account_id");--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_agent_id_retailer_accounts_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."retailer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variants_store_idx" ON "variants" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_store_sku_idx" ON "variants" USING btree ("store_id","sku") WHERE "variants"."sku" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variants_store_barcode_idx" ON "variants" USING btree ("store_id","barcode") WHERE "variants"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoices_pos_sale_idx" ON "invoices" USING btree ("pos_sale_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_guard" CHECK (("invoices"."order_id" IS NOT NULL) <> ("invoices"."pos_sale_id" IS NOT NULL));