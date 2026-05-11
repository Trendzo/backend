CREATE TYPE "public"."account_deletion_status" AS ENUM('pending', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."application_document_kind" AS ENUM('storefront_photo', 'address_proof', 'pan', 'gst_certificate', 'bank_proof', 'other');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('pending', 'under_review', 'docs_requested', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."change_request_field" AS ENUM('legal_name', 'address', 'bank_account', 'gstin');--> statement-breakpoint
CREATE TYPE "public"."change_request_status" AS ENUM('pending', 'under_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."data_export_status" AS ENUM('pending', 'building', 'ready', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."enforcement_breach_kind" AS ENUM('acceptance_rate', 'fulfilment_sla', 'dispute_rate', 'return_rate', 'kyc_overdue', 'policy_violation');--> statement-breakpoint
CREATE TYPE "public"."enforcement_step" AS ENUM('warning_1', 'warning_2', 'warning_3', 'suspension', 'termination', 'lifted');--> statement-breakpoint
CREATE TYPE "public"."inventory_adjustment_reason" AS ENUM('manual_edit', 'csv_import', 'order_reservation', 'order_confirmation', 'order_cancellation', 'return_restock', 'damage_writeoff', 'audit_correction');--> statement-breakpoint
CREATE TYPE "public"."kyc_document_status" AS ENUM('missing', 'pending_review', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kyc_reverification_status" AS ENUM('pending', 'submitted', 'approved', 'rejected', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."moderation_flag_source" AS ENUM('automation', 'user_report', 'admin_review');--> statement-breakpoint
CREATE TYPE "public"."moderation_flag_status" AS ENUM('open', 'under_appeal', 'resolved_taken_down', 'resolved_restored', 'resolved_dismissed');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('inbox', 'push', 'email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('order', 'refund', 'payout', 'kyc', 'system', 'issue', 'compliance', 'promotion');--> statement-breakpoint
CREATE TYPE "public"."password_reset_token_kind" AS ENUM('consumer', 'retailer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."staff_invite_status" AS ENUM('pending', 'accepted', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."sub_role_scope" AS ENUM('admin', 'retailer');--> statement-breakpoint
CREATE TYPE "public"."verification_check_kind" AS ENUM('gstin', 'pan', 'bank_penny_drop');--> statement-breakpoint
CREATE TYPE "public"."verification_check_status" AS ENUM('pending', 'in_progress', 'verified', 'failed');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"impersonated_store_id" text,
	"request_id" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "impersonation_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" text NOT NULL,
	"store_id" text NOT NULL,
	"retailer_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"account_kind" "password_reset_token_kind" NOT NULL,
	"account_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retailer_staff_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"email" text NOT NULL,
	"sub_role" "retailer_sub_role" NOT NULL,
	"invited_by_account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"status" "staff_invite_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sub_role_permission_overrides" (
	"scope" "sub_role_scope" NOT NULL,
	"sub_role" text NOT NULL,
	"action" text NOT NULL,
	"allowed" boolean NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_account_id" text,
	CONSTRAINT "sub_role_permission_overrides_scope_sub_role_action_pk" PRIMARY KEY("scope","sub_role","action")
);
--> statement-breakpoint
CREATE TABLE "application_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"kind" "application_document_kind" NOT NULL,
	"url" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewer_note" text
);
--> statement-breakpoint
CREATE TABLE "application_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_account_id" text,
	"applicant_email" text,
	"body" text NOT NULL,
	"attachment_urls" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_verification_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"kind" "verification_check_kind" NOT NULL,
	"status" "verification_check_status" DEFAULT 'pending' NOT NULL,
	"raw_response" jsonb,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "retailer_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"gstin" text NOT NULL,
	"pan" text,
	"owner_name" text NOT NULL,
	"owner_email" text NOT NULL,
	"owner_phone" text NOT NULL,
	"address_line" text NOT NULL,
	"pincode" text NOT NULL,
	"state_code" text NOT NULL,
	"lat" text,
	"lng" text,
	"hours" jsonb,
	"categories" jsonb,
	"brands" jsonb,
	"sample_skus" jsonb,
	"bank_legal_name" text,
	"bank_account_number" text,
	"bank_ifsc" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" text,
	"decision_reason" text,
	"provisioned_retailer_account_id" text
);
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"status" "account_deletion_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"field" "change_request_field" NOT NULL,
	"current_value" text NOT NULL,
	"requested_value" text NOT NULL,
	"status" "change_request_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" text,
	"decision_note" text,
	"evidence_url" text
);
--> statement-breakpoint
CREATE TABLE "data_export_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"status" "data_export_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"download_url" text,
	"expires_at" timestamp with time zone,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "kyc_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"reverification_id" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"status" "kyc_document_status" DEFAULT 'missing' NOT NULL,
	"uploaded_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewer_note" text
);
--> statement-breakpoint
CREATE TABLE "kyc_reverifications" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"status" "kyc_reverification_status" DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"grace_period_ends_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" text,
	"decision_reason" text,
	"last_verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_enforcement_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"step" "enforcement_step" NOT NULL,
	"breach_kind" "enforcement_breach_kind" NOT NULL,
	"metric" jsonb,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acted_by_account_id" text,
	"reason" text,
	"lifts_action_id" text
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"account_kind" "actor_type" NOT NULL,
	"account_id" text NOT NULL,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"daily_digest_enabled" boolean DEFAULT false NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"language" text DEFAULT 'en-IN' NOT NULL,
	"dashboard_tiles" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_account_kind_account_id_pk" PRIMARY KEY("account_kind","account_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_kind" "actor_type" NOT NULL,
	"recipient_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"channel" "notification_channel" DEFAULT 'inbox' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"deep_link" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "store_holiday_closures" (
	"store_id" text NOT NULL,
	"date" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" text,
	CONSTRAINT "store_holiday_closures_store_id_date_pk" PRIMARY KEY("store_id","date")
);
--> statement-breakpoint
CREATE TABLE "listing_audit_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "listing_moderation_appeals" (
	"id" text PRIMARY KEY NOT NULL,
	"flag_id" text NOT NULL,
	"retailer_account_id" text NOT NULL,
	"body" text NOT NULL,
	"attachment_urls" jsonb,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" text,
	"outcome" text,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "listing_moderation_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"source" "moderation_flag_source" NOT NULL,
	"reason_code" text NOT NULL,
	"details" text,
	"reported_by_consumer_id" text,
	"rule_key" text,
	"status" "moderation_flag_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_account_id" text,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"delta" integer NOT NULL,
	"new_stock" integer NOT NULL,
	"reason" "inventory_adjustment_reason" NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"ref_kind" text,
	"ref_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"qty" integer NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_admin_id_admin_accounts_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_staff_invites" ADD CONSTRAINT "retailer_staff_invites_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_staff_invites" ADD CONSTRAINT "retailer_staff_invites_invited_by_account_id_retailer_accounts_id_fk" FOREIGN KEY ("invited_by_account_id") REFERENCES "public"."retailer_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_application_id_retailer_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."retailer_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "application_messages_application_id_retailer_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."retailer_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_verification_checks" ADD CONSTRAINT "application_verification_checks_application_id_retailer_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."retailer_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_applications" ADD CONSTRAINT "retailer_applications_provisioned_retailer_account_id_retailer_accounts_id_fk" FOREIGN KEY ("provisioned_retailer_account_id") REFERENCES "public"."retailer_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_requests" ADD CONSTRAINT "data_export_requests_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_reverification_id_kyc_reverifications_id_fk" FOREIGN KEY ("reverification_id") REFERENCES "public"."kyc_reverifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_reverifications" ADD CONSTRAINT "kyc_reverifications_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_enforcement_actions" ADD CONSTRAINT "policy_enforcement_actions_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_holiday_closures" ADD CONSTRAINT "store_holiday_closures_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_audit_entries" ADD CONSTRAINT "listing_audit_entries_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_moderation_appeals" ADD CONSTRAINT "listing_moderation_appeals_flag_id_listing_moderation_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."listing_moderation_flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_moderation_flags" ADD CONSTRAINT "listing_moderation_flags_listing_id_product_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."product_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_actor_at_idx" ON "audit_log" USING btree ("id","actor_kind","actor_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_account_id_idx" ON "password_reset_tokens" USING btree ("id","account_kind","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retailer_staff_invites_store_email_pending_idx" ON "retailer_staff_invites" USING btree ("store_id","email","status");--> statement-breakpoint
CREATE UNIQUE INDEX "retailer_applications_status_id_idx" ON "retailer_applications" USING btree ("status","id");