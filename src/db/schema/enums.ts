import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * All Postgres enum types live here. Drizzle creates them ahead of any table that uses them.
 * Order matters only for migration generation (drizzle-kit handles this for us).
 */

// ===== Identity =====
export const consumerStatus = pgEnum('consumer_status', ['active', 'suspended', 'closed']);
export const retailerAccountStatus = pgEnum('retailer_account_status', [
  'pending_approval', // freshly signed up, awaiting admin approval
  'active',
  'terminated', // account permanently dead (rejection, admin termination, staff revoke)
]);
export const retailerSubRole = pgEnum('retailer_sub_role', [
  'owner',
  'manager',
  'staff',
  'delivery_agent',
]);
export const adminAccountStatus = pgEnum('admin_account_status', ['active', 'revoked']);
export const adminSubRole = pgEnum('admin_sub_role', ['super_admin', 'ops_admin', 'support']);
export const deliveryAgentStatus = pgEnum('delivery_agent_status', ['active', 'inactive']);

// Used in transitions, audit fields, anywhere actor identity is polymorphic
export const actorType = pgEnum('actor_type', [
  'consumer',
  'retailer',
  'admin',
  'delivery_agent',
  'system',
]);

// ===== Phase 1: Identity & Access =====
export const staffInviteStatus = pgEnum('staff_invite_status', [
  'pending',
  'accepted',
  'expired',
  'revoked',
]);
export const passwordResetTokenKind = pgEnum('password_reset_token_kind', [
  'consumer',
  'retailer',
  'admin',
]);
export const subRoleScope = pgEnum('sub_role_scope', ['admin', 'retailer']);

// ===== Phase 2: Retailer Onboarding =====
export const applicationStatus = pgEnum('application_status', [
  'pending',
  'docs_requested',
  'approved',
  'rejected',
]);
export const applicationDocumentKind = pgEnum('application_document_kind', [
  'storefront_photo',
  'address_proof',
  'pan',
  'gst_certificate',
  'bank_proof',
  'other',
]);
export const verificationCheckKind = pgEnum('verification_check_kind', [
  'gstin',
  'pan',
  'bank_penny_drop',
]);
export const verificationCheckStatus = pgEnum('verification_check_status', [
  'pending',
  'in_progress',
  'verified',
  'failed',
]);

// ===== Phase 3: KYC & Compliance =====
export const kycReverificationStatus = pgEnum('kyc_reverification_status', [
  'pending',
  'submitted',
  'approved',
  'rejected',
  'overdue',
]);
export const kycDocumentStatus = pgEnum('kyc_document_status', [
  'missing',
  'pending_review',
  'verified',
  'rejected',
]);
export const changeRequestStatus = pgEnum('change_request_status', [
  'pending',
  'under_review',
  'approved',
  'rejected',
]);
export const changeRequestField = pgEnum('change_request_field', [
  'legal_name',
  'address',
  'bank_account',
  'gstin',
]);
export const dataExportStatus = pgEnum('data_export_status', [
  'pending',
  'building',
  'ready',
  'expired',
  'failed',
]);
export const accountDeletionStatus = pgEnum('account_deletion_status', [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);
export const enforcementStep = pgEnum('enforcement_step', [
  'warning_1',
  'warning_2',
  'warning_3',
  'suspension',
  'termination',
  'lifted',
]);
export const enforcementBreachKind = pgEnum('enforcement_breach_kind', [
  'acceptance_rate',
  'fulfilment_sla',
  'dispute_rate',
  'return_rate',
  'kyc_overdue',
  'policy_violation',
]);

// ===== Phase 4: Store Operations =====
export const notificationKind = pgEnum('notification_kind', [
  'order',
  'refund',
  'payout',
  'kyc',
  'system',
  'issue',
  'compliance',
  'promotion',
]);
export const notificationChannel = pgEnum('notification_channel', [
  'inbox',
  'push',
  'email',
  'sms',
]);

// ===== Phase 5: Catalog Moderation =====
export const moderationFlagSource = pgEnum('moderation_flag_source', [
  'automation',
  'user_report',
  'admin_review',
]);
export const moderationFlagStatus = pgEnum('moderation_flag_status', [
  'open',
  'under_appeal',
  'resolved_taken_down',
  'resolved_restored',
  'resolved_dismissed',
]);

// ===== Phase 6: Inventory =====
export const inventoryAdjustmentReason = pgEnum('inventory_adjustment_reason', [
  'manual_edit',
  'csv_import',
  'order_reservation',
  'order_confirmation',
  'order_cancellation',
  'return_restock',
  'damage_writeoff',
  'audit_correction',
  // ===== Offline POS (counter sales) =====
  'pos_sale', // stock sold over the counter
  'pos_return_restock', // returned counter item put back on the shelf
  'pos_void_restock', // a completed sale voided same-day; stock restored
]);

// ===== Store =====
export const retailerStoreStatus = pgEnum('retailer_store_status', [
  'onboarding',
  'active',
  'paused',
  'suspended',
  'terminated',
]);
export const pauseVisibility = pgEnum('pause_visibility', ['visible', 'hidden']);

// ===== Catalog =====
export const gender = pgEnum('gender', ['her', 'him', 'unisex']);
// How the retailer structures a listing's variants:
//   single     — one system-created default variant (default group only)
//   color_size — system parent-child flow: color groups, size variants
//   custom     — retailer-defined attribute template (flat axes, default group)
export const variantMode = pgEnum('variant_mode', ['single', 'color_size', 'custom']);
export const listingPolicy = pgEnum('listing_policy', ['return', 'replace', 'final_sale']);
export const listingStatus = pgEnum('listing_status', ['draft', 'active', 'retired', 'taken_down']);
export const aiCatalogMode = pgEnum('ai_catalog_mode', ['without_model', 'with_model']);
export const aiCatalogStatus = pgEnum('ai_catalog_status', [
  'submitted',
  'processing',
  'ready_for_review',
  'accepted',
  'rejected',
  'regenerating',
  'failed',
]);
export const collectionKind = pgEnum('collection_kind', [
  'outfit', // curated multi-listing look (frontend's "GET THE LOOK" bundles)
  'occasion', // contextual grouping ("Brunch", "Party", "Beach")
  'drop', // time-bound launch
  'edit', // editorial selection
  'trend', // trending grouping
  'brand', // brand spotlight — auto-resolves to that brand's active listings
]);
export const collectionStatus = pgEnum('collection_status', ['draft', 'active', 'archived']);

// ===== Orders =====
export const deliveryMethod = pgEnum('delivery_method', [
  'express',
  'standard',
  'pickup',
  'try_and_buy',
]);
export const paymentMethod = pgEnum('payment_method', [
  'upi',
  'card',
  'cod',
  'wallet',
  'gift_card',
]);
export const orderStatus = pgEnum('order_status', [
  'pending',
  'confirmed',
  'routing',
  'accepted',
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'undelivered',
  'returning_to_store',
  'returned_to_store',
  'delivered',
  'cancelled',
  'payment_failed',
  'closed',
]);
export const orderGroupStatus = pgEnum('order_group_status', [
  'in_flight',
  'partially_delivered',
  'all_delivered',
  'partially_cancelled',
  'all_cancelled',
]);
export const orderItemOutcome = pgEnum('order_item_outcome', [
  'pending_delivery',
  'delivered_kept',
  'at_door_kept',
  'at_door_returned',
  'at_door_refused',
  'at_door_return_rejected', // customer tried to return wrong/defective item; agent rejected → customer keeps it, no refund

  'at_store_pending_verification',
  'store_accepted_return',
  'store_rejected_held',
  'held_collected_at_counter',
  'held_redelivered',
  'held_abandoned',
  'held_window_expired',
  'dispute_open',
  'dispute_resolved_refund',
  'dispute_resolved_fresh_delivery',
  'dispute_resolved_pickup',
  'dispute_resolved_no_refund',
  'cancelled',
]);
export const taxSplitKind = pgEnum('tax_split_kind', ['intra_state', 'inter_state']);
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'superseded',
]);
export const deliveryAttemptOutcome = pgEnum('delivery_attempt_outcome', [
  'delivered',
  'undelivered',
  'returning_to_store',
]);

// ===== Returns / Disputes =====
export const returnKind = pgEnum('return_kind', ['door_return', 'standard_return']);
export const returnReasonCategory = pgEnum('return_reason_category', [
  'damaged',
  'wrong_item',
  'not_as_described',
  'doesnt_fit',
  'other',
]);
export const agentDisposition = pgEnum('agent_disposition', [
  'kept',
  'returned',
  'refused',
  'return_rejected', // agent rejected the customer's return at the door (wrong/defective)
]);
export const storeReturnDecision = pgEnum('store_return_decision', [
  'pending',
  'accepted',
  'rejected', // store rejected on receipt; goods shelved as a held item
  'rejected_at_door', // agent rejected at the door; goods stayed with customer (no held item, no refund)
]);
export const heldItemStatus = pgEnum('held_item_status', ['holding', 'expired', 'resolved']);
export const heldItemDisposition = pgEnum('held_item_disposition', [
  'returned_to_consumer',
  'redelivered',
  'forfeited_to_store',
  'restocked',
  'written_off',
]);
export const disputeStatus = pgEnum('dispute_status', [
  'open',
  'requested_evidence',
  'decided',
  'escalated',
]);
export const disputeDecision = pgEnum('dispute_decision', [
  'refund',
  'fresh_delivery',
  'pickup',
  'no_refund',
  'split',
]);

// ===== Refunds =====
export const refundStatus = pgEnum('refund_status', [
  'pending',
  'processing',
  'succeeded',
  'partially_disbursed',
  'failed',
]);
export const refundDisbursementDestination = pgEnum('refund_disbursement_destination', [
  'original_tender',
  'wallet',
]);
export const refundDisbursementStatus = pgEnum('refund_disbursement_status', [
  'pending',
  'succeeded',
  'failed',
]);

// ===== Money =====
export const walletTransactionKind = pgEnum('wallet_transaction_kind', [
  'top_up',
  'debit',
  'refund_credit',
  'gift_card_credit',
  'adjustment',
]);
export const loyaltyTransactionKind = pgEnum('loyalty_transaction_kind', [
  'earn',
  'redeem',
  'refund_credit',
  'adjustment',
  'bonus',
]);
export const invoiceKind = pgEnum('invoice_kind', [
  'tax_invoice',
  'supplementary_invoice',
  'commission_invoice',
  'bill_of_supply',
  'pos_tax_invoice', // offline counter-sale GST invoice (retailer's own GSTIN → walk-in)
]);

// ===== Offline POS (counter sales) =====
export const posSaleStatus = pgEnum('pos_sale_status', [
  'held', // parked bill; no stock movement yet
  'completed', // settled; stock decremented, invoice issued
  'voided', // completed sale reversed same-day
]);
export const posTenderMethod = pgEnum('pos_tender_method', ['cash', 'card', 'upi']);
export const posPricingMode = pgEnum('pos_pricing_mode', ['tax_inclusive', 'tax_exclusive']);
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'credited']);
export const payoutStatus = pgEnum('payout_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

// ===== Promotions =====
export const promotionMechanism = pgEnum('promotion_mechanism', ['offer', 'coupon', 'voucher']);
export const promotionDiscountType = pgEnum('promotion_discount_type', [
  'flat_amount',
  'percent',
  'percent_upto',
  'bogo',
  'bxgy',
  'bundle',
  'tiered_cart',
  'free_shipping',
]);
export const promotionStatus = pgEnum('promotion_status', [
  'draft',
  'scheduled',
  'active',
  'paused',
  'expired',
  'exhausted',
  'revoked',
]);
export const promotionIssuerType = pgEnum('promotion_issuer_type', [
  'admin',
  'retailer',
  'system',
]);
export const promotionAppliedTo = pgEnum('promotion_applied_to', [
  'retailer_promo',
  'platform_promo',
  'coupon',
  'shipping',
  'loyalty',
]);
export const clubbingDefault = pgEnum('clubbing_default', [
  'allowed',
  'disallowed',
  'always_allowed',
]);

// ===== §14 Wallet Payouts =====
export const walletPayoutStatus = pgEnum('wallet_payout_status', [
  'pending_claim',
  'awaiting_bank',
  'paid',
  'escheated',
  'failed',
]);

// ===== §17 GST Returns =====
export const gstReturnKind = pgEnum('gst_return_kind', ['gstr1', 'gstr3b', 'tcs_reconciliation']);
export const gstReturnStatus = pgEnum('gst_return_status', [
  'pending',
  'generating',
  'ready',
  'failed',
]);

// ===== §17 Invoice Numbering =====
export const invoiceResetCycle = pgEnum('invoice_reset_cycle', [
  'never',
  'fiscal_year',
  'monthly',
]);

// ===== §16/§18 Post-Payout Recovery =====
export const postPayoutRecoveryStatus = pgEnum('post_payout_recovery_status', [
  'planned',
  'debited',
  'failed',
  'cancelled',
]);

// ===== §18 Settlement =====
export const earlyDisbursementStatus = pgEnum('early_disbursement_status', [
  'pending',
  'approved',
  'rejected',
]);

export const payoutHoldStatus = pgEnum('payout_hold_status', ['active', 'released']);
export const payoutAdjustmentDirection = pgEnum('payout_adjustment_direction', ['debit', 'credit']);
export const payoutAdjustmentKind = pgEnum('payout_adjustment_kind', [
  'manual',
  'dispute_liability',
]);
export const billingStatementStatus = pgEnum('billing_statement_status', [
  'open',
  'closing',
  'closed',
]);

// ===== Support =====
export const supportTicketStatus = pgEnum('support_ticket_status', [
  'open',
  'in_progress',
  'resolved',
  'closed',
]);
export const supportSenderType = pgEnum('support_sender_type', [
  'consumer',
  'retailer',
  'admin',
  'system',
]);

// ===== §19 Customer Issues =====
export const issueKind = pgEnum('issue_kind', ['query', 'complaint', 'dispute']);
export const awaitingParty = pgEnum('awaiting_party', [
  'admin',
  'retailer',
  'consumer',
  'none',
]);

// ===== §20 Consumer Management — bans + community + moderation =====
export const consumerBanSurface = pgEnum('consumer_ban_surface', [
  'posts',
  'reviews',
  'rewards',
]);
export const communityPostStatus = pgEnum('community_post_status', [
  'active',
  'taken_down',
  'hidden_pending_review',
]);
export const productReviewStatus = pgEnum('product_review_status', [
  'active',
  'taken_down',
  'hidden_pending_review',
]);
export const moderationTargetType = pgEnum('moderation_target_type', [
  'community_post',
  'product_review',
]);
export const moderationReportSource = pgEnum('moderation_report_source', [
  'auto',
  'user',
]);
export const moderationReportStatus = pgEnum('moderation_report_status', [
  'pending',
  'actioned',
  'dismissed',
]);
export const moderationActionKind = pgEnum('moderation_action_kind', [
  'approve',
  'edit',
  'takedown',
]);

// ===== §22 Notifications =====
export const pushSubscriptionPlatform = pgEnum('push_subscription_platform', [
  'web',
  'ios',
  'android',
]);
export const pushAttemptStatus = pgEnum('push_attempt_status', [
  'pending',
  'sent',
  'failed',
  'skipped_disabled',
]);
export const bannerScope = pgEnum('banner_scope', [
  'all_retailers',
  'store',
  'all_admins',
]);
export const bannerSeverity = pgEnum('banner_severity', [
  'info',
  'warning',
  'critical',
]);
export const emailOutboxStatus = pgEnum('email_outbox_status', [
  'pending',
  'sent',
  'failed',
]);

// ===== §15 Payment Capture — reconciliation =====
export const paymentSettlementStatus = pgEnum('payment_settlement_status', [
  'uploaded',     // file just ingested; not yet reconciled
  'reconciled',   // every entry matched a payment cleanly
  'partial',      // some entries unmatched / mismatched; discrepancies pending
  'closed',       // admin marked the cycle finalised after triage
]);

export const paymentSettlementEntryMatchStatus = pgEnum(
  'payment_settlement_entry_match_status',
  ['pending', 'matched', 'amount_mismatch', 'missing_in_capture', 'status_mismatch', 'duplicate'],
);

export const paymentReconDiscrepancyKind = pgEnum('payment_recon_discrepancy_kind', [
  'amount_mismatch',
  'missing_in_capture',
  'missing_in_settlement',
  'status_mismatch',
  'duplicate',
]);

