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
  'deactivated',
]);
export const retailerSubRole = pgEnum('retailer_sub_role', ['owner', 'manager', 'staff']);
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
export const listingBadge = pgEnum('listing_badge', ['new', 'hot', 'trending', 'none']);
export const listingPolicy = pgEnum('listing_policy', ['return', 'replace', 'final_sale']);
export const listingStatus = pgEnum('listing_status', ['draft', 'active', 'retired']);
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
export const agentDisposition = pgEnum('agent_disposition', ['kept', 'returned', 'refused']);
export const storeReturnDecision = pgEnum('store_return_decision', [
  'pending',
  'accepted',
  'rejected',
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
]);
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

