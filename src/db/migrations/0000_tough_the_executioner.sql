CREATE TYPE "public"."actor_type" AS ENUM('consumer', 'retailer', 'admin', 'delivery_agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."admin_account_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."admin_sub_role" AS ENUM('super_admin', 'ops_admin', 'support');--> statement-breakpoint
CREATE TYPE "public"."agent_disposition" AS ENUM('kept', 'returned', 'refused');--> statement-breakpoint
CREATE TYPE "public"."ai_catalog_mode" AS ENUM('without_model', 'with_model');--> statement-breakpoint
CREATE TYPE "public"."ai_catalog_status" AS ENUM('submitted', 'processing', 'ready_for_review', 'accepted', 'rejected', 'regenerating', 'failed');--> statement-breakpoint
CREATE TYPE "public"."clubbing_default" AS ENUM('allowed', 'disallowed', 'always_allowed');--> statement-breakpoint
CREATE TYPE "public"."collection_kind" AS ENUM('outfit', 'occasion', 'drop', 'edit', 'trend');--> statement-breakpoint
CREATE TYPE "public"."collection_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."consumer_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."delivery_agent_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."delivery_attempt_outcome" AS ENUM('delivered', 'undelivered', 'returning_to_store');--> statement-breakpoint
CREATE TYPE "public"."delivery_method" AS ENUM('express', 'standard', 'pickup', 'try_and_buy');--> statement-breakpoint
CREATE TYPE "public"."dispute_decision" AS ENUM('refund', 'fresh_delivery', 'pickup', 'no_refund', 'split');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'requested_evidence', 'decided', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('her', 'him', 'unisex');--> statement-breakpoint
CREATE TYPE "public"."held_item_disposition" AS ENUM('returned_to_consumer', 'redelivered', 'forfeited_to_store', 'restocked', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."held_item_status" AS ENUM('holding', 'expired', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('tax_invoice', 'supplementary_invoice', 'commission_invoice', 'bill_of_supply');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'credited');--> statement-breakpoint
CREATE TYPE "public"."listing_badge" AS ENUM('new', 'hot', 'trending', 'none');--> statement-breakpoint
CREATE TYPE "public"."listing_policy" AS ENUM('return', 'replace', 'final_sale');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."loyalty_transaction_kind" AS ENUM('earn', 'redeem', 'refund_credit', 'adjustment', 'bonus');--> statement-breakpoint
CREATE TYPE "public"."order_group_status" AS ENUM('in_flight', 'partially_delivered', 'all_delivered', 'partially_cancelled', 'all_cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_item_outcome" AS ENUM('pending_delivery', 'delivered_kept', 'at_door_kept', 'at_door_returned', 'at_door_refused', 'at_store_pending_verification', 'store_accepted_return', 'store_rejected_held', 'held_collected_at_counter', 'held_redelivered', 'held_abandoned', 'held_window_expired', 'dispute_open', 'dispute_resolved_refund', 'dispute_resolved_fresh_delivery', 'dispute_resolved_pickup', 'dispute_resolved_no_refund', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'routing', 'accepted', 'packed', 'picked_up', 'out_for_delivery', 'at_door', 'undelivered', 'returning_to_store', 'returned_to_store', 'delivered', 'cancelled', 'payment_failed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."pause_visibility" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('upi', 'card', 'cod', 'wallet', 'gift_card');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."promotion_applied_to" AS ENUM('retailer_promo', 'platform_promo', 'coupon', 'shipping', 'loyalty');--> statement-breakpoint
CREATE TYPE "public"."promotion_discount_type" AS ENUM('flat_amount', 'percent', 'percent_upto', 'bogo', 'bxgy', 'bundle', 'tiered_cart', 'free_shipping');--> statement-breakpoint
CREATE TYPE "public"."promotion_issuer_type" AS ENUM('admin', 'retailer', 'system');--> statement-breakpoint
CREATE TYPE "public"."promotion_mechanism" AS ENUM('offer', 'coupon', 'voucher');--> statement-breakpoint
CREATE TYPE "public"."promotion_status" AS ENUM('draft', 'scheduled', 'active', 'paused', 'expired', 'exhausted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."refund_disbursement_destination" AS ENUM('original_tender', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."refund_disbursement_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'processing', 'succeeded', 'partially_disbursed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."retailer_account_status" AS ENUM('pending_approval', 'active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."retailer_store_status" AS ENUM('onboarding', 'active', 'paused', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."retailer_sub_role" AS ENUM('owner', 'manager', 'staff');--> statement-breakpoint
CREATE TYPE "public"."return_kind" AS ENUM('door_return', 'standard_return');--> statement-breakpoint
CREATE TYPE "public"."store_return_decision" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."support_sender_type" AS ENUM('consumer', 'retailer', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('open', 'in_progress', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."tax_split_kind" AS ENUM('intra_state', 'inter_state');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_kind" AS ENUM('top_up', 'debit', 'refund_credit', 'gift_card_credit', 'adjustment');--> statement-breakpoint
CREATE TABLE "admin_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"sub_role" "admin_sub_role" NOT NULL,
	"status" "admin_account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"gender_preference" "gender",
	"signup_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "consumer_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"status" "delivery_agent_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"legal_name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "retailer_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"legal_name" text NOT NULL,
	"phone" text NOT NULL,
	"gstin" text NOT NULL,
	"sub_role" "retailer_sub_role" DEFAULT 'owner' NOT NULL,
	"status" "retailer_account_status" DEFAULT 'pending_approval' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retailer_stores" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_entity_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"gstin" text NOT NULL,
	"pan" text,
	"address" text NOT NULL,
	"state_code" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"opening_hours" jsonb,
	"status" "retailer_store_status" DEFAULT 'onboarding' NOT NULL,
	"pause_visibility" "pause_visibility",
	"pause_reason" text,
	"pause_until" timestamp with time zone,
	"platform_fee_bp" integer NOT NULL,
	"delivery_override_paise" integer,
	"handling_fee_paise" integer,
	"convenience_fee_paise" integer,
	"payout_cadence_days" integer DEFAULT 7 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retailer_stores_pause_guard" CHECK ("retailer_stores"."status" = 'paused' OR ("retailer_stores"."pause_visibility" IS NULL AND "retailer_stores"."pause_reason" IS NULL AND "retailer_stores"."pause_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tint_color" text,
	"logo_url" text,
	"domain" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"parent_id" text,
	"icon_name" text,
	"tint_color" text,
	"image_url" text,
	"gender" "gender" DEFAULT 'unisex' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"template_id" text,
	"brand_id" text NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"hsn" text,
	"gender" "gender" NOT NULL,
	"badge" "listing_badge" DEFAULT 'none' NOT NULL,
	"listing_policy" "listing_policy" DEFAULT 'return' NOT NULL,
	"gallery_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"rating_avg" numeric(3, 2) DEFAULT '0' NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_listings_rating_guard" CHECK ("product_listings"."rating_avg" >= 0 AND "product_listings"."rating_avg" <= 5 AND "product_listings"."rating_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"sku" text,
	"attributes" jsonb NOT NULL,
	"attributes_label" text NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"price_paise" integer NOT NULL,
	CONSTRAINT "variants_stock_guard" CHECK ("variants"."stock" >= 0 AND "variants"."reserved" >= 0 AND "variants"."reserved" <= "variants"."stock" AND "variants"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_catalog_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"listing_id" text,
	"mode" "ai_catalog_mode" NOT NULL,
	"raw_photos" jsonb NOT NULL,
	"output_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "ai_catalog_status" DEFAULT 'submitted' NOT NULL,
	"cost_paise" integer,
	"parent_submission_id" text,
	"third_party_request_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_store_id" text,
	"name" text NOT NULL,
	"axes" jsonb NOT NULL,
	"is_platform_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_listings" (
	"collection_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_listings_collection_id_listing_id_pk" PRIMARY KEY("collection_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "collection_kind" NOT NULL,
	"gender" "gender" DEFAULT 'unisex' NOT NULL,
	"description" text,
	"hero_image_url" text,
	"accent_colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"status" "collection_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"label" text,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"pincode" text NOT NULL,
	"state_code" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"delivery_agent_id" text,
	"attempt_number" integer NOT NULL,
	"outcome" "delivery_attempt_outcome" NOT NULL,
	"notes" text,
	"proof_photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_attempt_guard" CHECK ("delivery_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"status" "order_group_status" DEFAULT 'in_flight' NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"listing_name_snap" text NOT NULL,
	"brand_snap" text NOT NULL,
	"category_snap" text NOT NULL,
	"hsn_snap" text,
	"gallery_image_snap" text,
	"attributes_label_snap" text NOT NULL,
	"listing_policy_snap" "listing_policy" NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"line_subtotal_paise" integer NOT NULL,
	"retailer_promo_alloc_paise" integer DEFAULT 0 NOT NULL,
	"platform_promo_alloc_paise" integer DEFAULT 0 NOT NULL,
	"coupon_alloc_paise" integer DEFAULT 0 NOT NULL,
	"points_alloc_paise" integer DEFAULT 0 NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"gst_alloc_paise" integer NOT NULL,
	"net_line_paise" integer NOT NULL,
	"outcome" "order_item_outcome" DEFAULT 'pending_delivery' NOT NULL,
	CONSTRAINT "order_items_qty_price_guard" CHECK ("order_items"."qty" > 0 AND "order_items"."unit_price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"store_id" text NOT NULL,
	"address_id" text,
	"delivery_method" "delivery_method" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_method_label" text NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"consumer_name_snap" text NOT NULL,
	"consumer_email_snap" text NOT NULL,
	"consumer_phone_snap" text NOT NULL,
	"address_line1_snap" text,
	"address_line2_snap" text,
	"address_city_snap" text,
	"address_pincode_snap" text,
	"address_state_code_snap" text,
	"address_lat_snap" double precision,
	"address_lng_snap" double precision,
	"store_name_snap" text NOT NULL,
	"store_address_snap" text NOT NULL,
	"store_gstin_snap" text NOT NULL,
	"store_state_code_snap" text NOT NULL,
	"items_subtotal_paise" integer NOT NULL,
	"retailer_promo_paise" integer DEFAULT 0 NOT NULL,
	"platform_promo_paise" integer DEFAULT 0 NOT NULL,
	"coupon_paise" integer DEFAULT 0 NOT NULL,
	"points_redeemed_paise" integer DEFAULT 0 NOT NULL,
	"wallet_applied_paise" integer DEFAULT 0 NOT NULL,
	"tax_paise" integer NOT NULL,
	"tax_split_kind" "tax_split_kind" NOT NULL,
	"cgst_paise" integer DEFAULT 0 NOT NULL,
	"sgst_paise" integer DEFAULT 0 NOT NULL,
	"igst_paise" integer DEFAULT 0 NOT NULL,
	"delivery_fee_paise" integer DEFAULT 0 NOT NULL,
	"handling_fee_paise" integer DEFAULT 0 NOT NULL,
	"convenience_fee_paise" integer DEFAULT 0 NOT NULL,
	"grand_total_paise" integer NOT NULL,
	"platform_fee_bp_snap" integer NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"pii_scrubbed_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "orders_address_presence_guard" CHECK ("orders"."address_id" IS NOT NULL OR "orders"."delivery_method" = 'pickup'),
	CONSTRAINT "orders_delivered_at_guard" CHECK ("orders"."status" <> 'delivered' OR "orders"."delivered_at" IS NOT NULL),
	CONSTRAINT "orders_gst_split_guard" CHECK (("orders"."tax_split_kind" = 'intra_state'
            AND "orders"."igst_paise" = 0
            AND "orders"."cgst_paise" + "orders"."sgst_paise" = "orders"."tax_paise")
        OR ("orders"."tax_split_kind" = 'inter_state'
            AND "orders"."cgst_paise" = 0
            AND "orders"."sgst_paise" = 0
            AND "orders"."igst_paise" = "orders"."tax_paise"))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"gateway_ref" text,
	"previous_payment_id" text,
	"idempotency_key" text NOT NULL,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "payments_settled_status_guard" CHECK (("payments"."status" IN ('pending','superseded'))
        OR ("payments"."status" = 'failed' AND "payments"."settled_at" IS NOT NULL)
        OR ("payments"."status" = 'succeeded' AND "payments"."settled_at" IS NOT NULL AND "payments"."gateway_ref" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"return_id" text,
	"opened_by_actor_type" "actor_type" NOT NULL,
	"opened_by_actor_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"decision" "dispute_decision",
	"decision_note" text,
	"decided_by_admin_id" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "disputes_target_xor" CHECK (("disputes"."order_id" IS NULL) <> ("disputes"."return_id" IS NULL)),
	CONSTRAINT "disputes_decision_guard" CHECK (("disputes"."status" = 'decided'
            AND "disputes"."decision" IS NOT NULL
            AND "disputes"."decided_at" IS NOT NULL
            AND "disputes"."decided_by_admin_id" IS NOT NULL)
        OR ("disputes"."status" <> 'decided'
            AND "disputes"."decision" IS NULL
            AND "disputes"."decided_at" IS NULL
            AND "disputes"."decided_by_admin_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "held_items" (
	"id" text PRIMARY KEY NOT NULL,
	"return_id" text NOT NULL,
	"store_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"status" "held_item_status" DEFAULT 'holding' NOT NULL,
	"disposition" "held_item_disposition",
	"holding_window_expires_at" timestamp with time zone NOT NULL,
	"extended_by_admin_id" text,
	"extension_reason" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "held_items_resolved_guard" CHECK ("held_items"."status" <> 'resolved' OR ("held_items"."disposition" IS NOT NULL AND "held_items"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" text PRIMARY KEY NOT NULL,
	"order_item_id" text NOT NULL,
	"kind" "return_kind" NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason_text" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_disposition" "agent_disposition",
	"store_decision" "store_return_decision" DEFAULT 'pending' NOT NULL,
	"store_decided_at" timestamp with time zone,
	"verification_window_expires_at" timestamp with time zone,
	CONSTRAINT "returns_door_agent_disposition_guard" CHECK ("returns"."kind" <> 'door_return' OR "returns"."agent_disposition" IS NOT NULL),
	CONSTRAINT "returns_store_decided_at_guard" CHECK ("returns"."store_decision" = 'pending' OR "returns"."store_decided_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "refund_disbursements" (
	"id" text PRIMARY KEY NOT NULL,
	"refund_id" text NOT NULL,
	"destination" "refund_disbursement_destination" NOT NULL,
	"source_payment_id" text,
	"amount_paise" integer NOT NULL,
	"status" "refund_disbursement_status" DEFAULT 'pending' NOT NULL,
	"gateway_ref" text,
	"previous_disbursement_id" text,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "refund_disbursements_destination_guard" CHECK (("refund_disbursements"."destination" = 'wallet' AND "refund_disbursements"."source_payment_id" IS NULL)
        OR ("refund_disbursements"."destination" = 'original_tender' AND "refund_disbursements"."source_payment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"refund_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"refunded_amount_paise" integer NOT NULL,
	"coupon_clawback_paise" integer DEFAULT 0 NOT NULL,
	"points_clawback_paise" integer DEFAULT 0 NOT NULL,
	"tax_refund_paise" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"total_refund_paise" integer NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "consumer_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"balance_paise" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_wallets_balance_non_negative" CHECK ("consumer_wallets"."balance_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"kind" "loyalty_transaction_kind" NOT NULL,
	"points" integer NOT NULL,
	"balance_after_points" integer NOT NULL,
	"ref_order_id" text,
	"note" text,
	"expires_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_transactions_sign_by_kind" CHECK (("loyalty_transactions"."kind" IN ('earn','refund_credit','bonus') AND "loyalty_transactions"."points" > 0)
        OR ("loyalty_transactions"."kind" = 'redeem' AND "loyalty_transactions"."points" < 0)
        OR ("loyalty_transactions"."kind" = 'adjustment')),
	CONSTRAINT "loyalty_transactions_balance_after_non_negative" CHECK ("loyalty_transactions"."balance_after_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"kind" "wallet_transaction_kind" NOT NULL,
	"amount_paise" integer NOT NULL,
	"balance_after_paise" integer NOT NULL,
	"wallet_version_after" integer NOT NULL,
	"ref_order_id" text,
	"ref_refund_id" text,
	"ref_gift_card_id" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_sign_by_kind" CHECK (("wallet_transactions"."kind" IN ('top_up','refund_credit','gift_card_credit') AND "wallet_transactions"."amount_paise" > 0)
        OR ("wallet_transactions"."kind" = 'debit' AND "wallet_transactions"."amount_paise" < 0)
        OR ("wallet_transactions"."kind" = 'adjustment')),
	CONSTRAINT "wallet_transactions_balance_after_non_negative" CHECK ("wallet_transactions"."balance_after_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_invoice_id" text NOT NULL,
	"refund_id" text,
	"legal_entity_id" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"series" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"credit_note_number" text NOT NULL,
	"consumer_name_snap" text NOT NULL,
	"consumer_billing_address_snap" text NOT NULL,
	"consumer_gstin_snap" text,
	"reason" text NOT NULL,
	"subtotal_reversed_paise" integer NOT NULL,
	"tax_reversed_paise" integer NOT NULL,
	"tcs_reversed_paise" integer DEFAULT 0 NOT NULL,
	"grand_total_reversed_paise" integer NOT NULL,
	"pdf_url" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_sequence_counters" (
	"legal_entity_id" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"series" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_sequence_counters_legal_entity_id_fiscal_year_series_pk" PRIMARY KEY("legal_entity_id","fiscal_year","series")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"legal_entity_id" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"series" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"invoice_number" text NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"consumer_name_snap" text NOT NULL,
	"consumer_billing_address_snap" text NOT NULL,
	"consumer_gstin_snap" text,
	"store_legal_name_snap" text NOT NULL,
	"store_address_snap" text NOT NULL,
	"store_gstin_snap" text NOT NULL,
	"store_state_code_snap" text NOT NULL,
	"subtotal_paise" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"taxable_value_paise" integer NOT NULL,
	"tax_split_kind" "tax_split_kind" NOT NULL,
	"cgst_paise" integer DEFAULT 0 NOT NULL,
	"sgst_paise" integer DEFAULT 0 NOT NULL,
	"igst_paise" integer DEFAULT 0 NOT NULL,
	"tcs_paise" integer DEFAULT 0 NOT NULL,
	"grand_total_paise" integer NOT NULL,
	"pdf_url" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_gst_split_guard" CHECK (("invoices"."tax_split_kind" = 'intra_state'
            AND "invoices"."igst_paise" = 0
            AND "invoices"."cgst_paise" + "invoices"."sgst_paise" + "invoices"."taxable_value_paise" >= 0
            AND "invoices"."cgst_paise" + "invoices"."sgst_paise" = "invoices"."grand_total_paise" - "invoices"."subtotal_paise" + "invoices"."discount_paise" - "invoices"."tcs_paise")
        OR ("invoices"."tax_split_kind" = 'inter_state'
            AND "invoices"."cgst_paise" = 0
            AND "invoices"."sgst_paise" = 0
            AND "invoices"."igst_paise" = "invoices"."grand_total_paise" - "invoices"."subtotal_paise" + "invoices"."discount_paise" - "invoices"."tcs_paise"))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"cycle_start" timestamp with time zone NOT NULL,
	"cycle_end" timestamp with time zone NOT NULL,
	"gross_paise" bigint NOT NULL,
	"commission_paise" bigint NOT NULL,
	"commission_tax_paise" bigint DEFAULT 0 NOT NULL,
	"refunds_held_paise" bigint DEFAULT 0 NOT NULL,
	"adjustments_paise" bigint DEFAULT 0 NOT NULL,
	"net_paise" bigint NOT NULL,
	"bank_account_id" text NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"statement_url" text,
	"gateway_payout_id" text,
	"initiated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_cycle_range_guard" CHECK ("payouts"."cycle_end" > "payouts"."cycle_start"),
	CONSTRAINT "payouts_gross_non_negative" CHECK ("payouts"."gross_paise" >= 0),
	CONSTRAINT "payouts_completed_at_guard" CHECK ("payouts"."status" <> 'completed' OR "payouts"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "clubbing_matrix_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"applied_to_a" "promotion_applied_to" NOT NULL,
	"applied_to_b" "promotion_applied_to" NOT NULL,
	"default_value" "clubbing_default" NOT NULL,
	"note" text,
	CONSTRAINT "clubbing_matrix_canonical_order" CHECK ("clubbing_matrix_entries"."applied_to_a" <= "clubbing_matrix_entries"."applied_to_b")
);
--> statement-breakpoint
CREATE TABLE "promotion_consumer_usage" (
	"promotion_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "promotion_consumer_usage_promotion_id_consumer_id_pk" PRIMARY KEY("promotion_id","consumer_id"),
	CONSTRAINT "promotion_consumer_usage_count_guard" CHECK ("promotion_consumer_usage"."use_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"promotion_id" text NOT NULL,
	"order_id" text NOT NULL,
	"consumer_id" text NOT NULL,
	"voucher_code_id" text,
	"amount_applied_paise" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text,
	"name" text NOT NULL,
	"mechanism" "promotion_mechanism" NOT NULL,
	"discount_type" "promotion_discount_type" NOT NULL,
	"issuer_type" "promotion_issuer_type" NOT NULL,
	"applied_to" "promotion_applied_to" NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stackable_with" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"non_stackable" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_uses" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"per_consumer_limit" integer,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"status" "promotion_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_counters_guard" CHECK ("promotions"."redeemed_count" >= 0
        AND ("promotions"."total_uses" IS NULL OR "promotions"."total_uses" >= 0)
        AND ("promotions"."total_uses" IS NULL OR "promotions"."redeemed_count" <= "promotions"."total_uses")
        AND ("promotions"."per_consumer_limit" IS NULL OR "promotions"."per_consumer_limit" >= 0)),
	CONSTRAINT "promotions_validity_guard" CHECK ("promotions"."valid_until" > "promotions"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "voucher_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"promotion_id" text NOT NULL,
	"code" text NOT NULL,
	"total_uses" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_codes_counters_guard" CHECK ("voucher_codes"."redeemed_count" >= 0
        AND ("voucher_codes"."total_uses" IS NULL OR "voucher_codes"."total_uses" >= 0)
        AND ("voucher_codes"."total_uses" IS NULL OR "voucher_codes"."redeemed_count" <= "voucher_codes"."total_uses"))
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"sender_type" "support_sender_type" NOT NULL,
	"sender_id" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"opened_by_actor_type" "actor_type" NOT NULL,
	"opened_by_actor_id" text NOT NULL,
	"order_id" text,
	"subject" text NOT NULL,
	"status" "support_ticket_status" DEFAULT 'open' NOT NULL,
	"assigned_admin_id" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"prior_value" jsonb,
	"last_changed_admin_id" text,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_accounts" ADD CONSTRAINT "retailer_accounts_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_listings" ADD CONSTRAINT "product_listings_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_listings" ADD CONSTRAINT "product_listings_template_id_attribute_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."attribute_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_listings" ADD CONSTRAINT "product_listings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_listings" ADD CONSTRAINT "product_listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_catalog_submissions" ADD CONSTRAINT "ai_catalog_submissions_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_catalog_submissions" ADD CONSTRAINT "ai_catalog_submissions_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_templates" ADD CONSTRAINT "attribute_templates_owner_store_id_retailer_stores_id_fk" FOREIGN KEY ("owner_store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_listings" ADD CONSTRAINT "collection_listings_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_listings" ADD CONSTRAINT "collection_listings_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_agent_id_delivery_agents_id_fk" FOREIGN KEY ("delivery_agent_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_groups" ADD CONSTRAINT "order_groups_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transitions" ADD CONSTRAINT "order_transitions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_group_id_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_previous_payment_id_fk" FOREIGN KEY ("previous_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_decided_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_items" ADD CONSTRAINT "held_items_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_items" ADD CONSTRAINT "held_items_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_items" ADD CONSTRAINT "held_items_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_items" ADD CONSTRAINT "held_items_extended_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("extended_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_source_payment_id_payments_id_fk" FOREIGN KEY ("source_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_disbursements" ADD CONSTRAINT "refund_disbursements_previous_disbursement_id_fk" FOREIGN KEY ("previous_disbursement_id") REFERENCES "public"."refund_disbursements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_wallets" ADD CONSTRAINT "consumer_wallets_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_ref_order_id_orders_id_fk" FOREIGN KEY ("ref_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_consumer_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."consumer_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_ref_order_id_orders_id_fk" FOREIGN KEY ("ref_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_ref_refund_id_refunds_id_fk" FOREIGN KEY ("ref_refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_parent_invoice_id_invoices_id_fk" FOREIGN KEY ("parent_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_consumer_usage" ADD CONSTRAINT "promotion_consumer_usage_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_consumer_usage" ADD CONSTRAINT "promotion_consumer_usage_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_voucher_code_id_voucher_codes_id_fk" FOREIGN KEY ("voucher_code_id") REFERENCES "public"."voucher_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_codes" ADD CONSTRAINT "voucher_codes_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_admin_id_admin_accounts_id_fk" FOREIGN KEY ("assigned_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_config" ADD CONSTRAINT "platform_config_last_changed_admin_id_admin_accounts_id_fk" FOREIGN KEY ("last_changed_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_accounts_email_idx" ON "admin_accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "consumers_email_idx" ON "consumers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "consumers_phone_idx" ON "consumers" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_default_per_store_idx" ON "bank_accounts" USING btree ("store_id") WHERE "bank_accounts"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "retailer_accounts_email_idx" ON "retailer_accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "retailer_stores_status_idx" ON "retailer_stores" USING btree ("status");--> statement-breakpoint
CREATE INDEX "retailer_stores_legal_entity_idx" ON "retailer_stores" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_idx" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "brands_active_idx" ON "brands" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_gender_active_idx" ON "categories" USING btree ("gender","is_active");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "product_listings_store_status_idx" ON "product_listings" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "product_listings_category_idx" ON "product_listings" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "product_listings_brand_idx" ON "product_listings" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "product_listings_gender_status_idx" ON "product_listings" USING btree ("gender","status");--> statement-breakpoint
CREATE INDEX "variants_listing_idx" ON "variants" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_listing_sku_idx" ON "variants" USING btree ("listing_id","sku") WHERE "variants"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "collection_listings_listing_idx" ON "collection_listings" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_slug_idx" ON "collections" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "collections_kind_gender_status_idx" ON "collections" USING btree ("kind","gender","status");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_consumer_idx" ON "carts" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "addresses_consumer_idx" ON "addresses" USING btree ("consumer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_order_attempt_idx" ON "delivery_attempts" USING btree ("order_id","attempt_number");--> statement-breakpoint
CREATE INDEX "order_groups_consumer_idx" ON "order_groups" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "order_transitions_order_at_idx" ON "order_transitions" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "orders_store_status_placed_idx" ON "orders" USING btree ("store_id","status","placed_at");--> statement-breakpoint
CREATE INDEX "orders_consumer_placed_idx" ON "orders" USING btree ("consumer_id","placed_at" desc);--> statement-breakpoint
CREATE INDEX "orders_group_idx" ON "orders" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_idx" ON "orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_order_status_idx" ON "payments" USING btree ("order_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_idx" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "disputes_order_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "disputes_return_idx" ON "disputes" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "held_items_store_status_expiry_idx" ON "held_items" USING btree ("store_id","status","holding_window_expires_at");--> statement-breakpoint
CREATE INDEX "held_items_consumer_status_idx" ON "held_items" USING btree ("consumer_id","status");--> statement-breakpoint
CREATE INDEX "held_items_return_idx" ON "held_items" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "returns_order_item_idx" ON "returns" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "returns_store_decision_idx" ON "returns" USING btree ("store_decision");--> statement-breakpoint
CREATE INDEX "refund_disbursements_refund_status_idx" ON "refund_disbursements" USING btree ("refund_id","status");--> statement-breakpoint
CREATE INDEX "refund_lines_refund_idx" ON "refund_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_lines_order_item_idx" ON "refund_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_wallets_consumer_idx" ON "consumer_wallets" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_consumer_at_idx" ON "loyalty_transactions" USING btree ("consumer_id","at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_wallet_at_idx" ON "wallet_transactions" USING btree ("wallet_id","at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_ref_order_idx" ON "wallet_transactions" USING btree ("ref_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_wallet_version_idx" ON "wallet_transactions" USING btree ("wallet_id","wallet_version_after");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_seq_unique_idx" ON "credit_notes" USING btree ("legal_entity_id","fiscal_year","series","sequence_no");--> statement-breakpoint
CREATE INDEX "credit_notes_parent_invoice_idx" ON "credit_notes" USING btree ("parent_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_seq_unique_idx" ON "invoices" USING btree ("legal_entity_id","fiscal_year","series","sequence_no");--> statement-breakpoint
CREATE INDEX "invoices_order_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoices_store_idx" ON "invoices" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "payouts_store_status_cycle_idx" ON "payouts" USING btree ("store_id","status","cycle_end");--> statement-breakpoint
CREATE UNIQUE INDEX "clubbing_matrix_pair_idx" ON "clubbing_matrix_entries" USING btree ("applied_to_a","applied_to_b");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_promo_order_idx" ON "promotion_redemptions" USING btree ("promotion_id","order_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_consumer_promo_idx" ON "promotion_redemptions" USING btree ("consumer_id","promotion_id");--> statement-breakpoint
CREATE INDEX "promotions_status_validity_idx" ON "promotions" USING btree ("status","valid_from","valid_until");--> statement-breakpoint
CREATE INDEX "promotions_store_idx" ON "promotions" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_codes_code_idx" ON "voucher_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "voucher_codes_promotion_idx" ON "voucher_codes" USING btree ("promotion_id");--> statement-breakpoint
CREATE INDEX "support_messages_ticket_at_idx" ON "support_messages" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_tickets_assigned_idx" ON "support_tickets" USING btree ("assigned_admin_id");--> statement-breakpoint
CREATE INDEX "support_tickets_opener_idx" ON "support_tickets" USING btree ("opened_by_actor_type","opened_by_actor_id");