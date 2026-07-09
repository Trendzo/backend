/**
 * Pure-function pricing engine types. The engine is fed structured inputs and produces
 * a structured breakdown matching the layered formula in PRODUCT_SPEC line 554–572.
 *
 * Nothing here touches the DB. The orchestrator will be called by Phase 7 checkout AND
 * by the admin Promotion Preview tool. Both feed the same shape.
 */
import type {
  AppliedTo,
  ClubbingDefaultValue,
  DiscountType,
  Mechanism,
  PromotionConfig,
} from '../promotions/schemas.js';

/** Single line in the cart for pricing purposes. */
export type CartLine = {
  /** Stable id within this cart (used to attribute discounts back to lines). */
  lineId: string;
  listingId: string;
  variantId: string;
  /** Optional metadata used by `bogo`/`bxgy`/`bundle` and scope filters. */
  brandId?: string | undefined;
  categoryId?: string | undefined;
  /** Owning store. Set on multi-store carts so store-scoped coupons attach only to
   *  eligible-store lines; unset on single-store carts (store-scope gated upstream). */
  storeId?: string | undefined;
  /** ₹ per unit, paise. */
  unitPricePaise: number;
  qty: number;
  /** GST rate, e.g. 5 = 5%. */
  gstRatePct: number;
};

export type DeliveryMethod = 'express' | 'standard' | 'pickup' | 'try_and_buy';
export type PaymentMethod = 'upi' | 'card' | 'cod' | 'wallet' | 'gift_card';

export type Cart = {
  consumerId: string;
  /** Buyer's state code (for inter/intra-state GST split). */
  consumerStateCode: string;
  /** Seller's state code. */
  storeStateCode: string;
  deliveryMethod: DeliveryMethod;
  paymentMethod: PaymentMethod;
  lines: CartLine[];
};

/**
 * A promotion as seen by the engine — only the fields needed to evaluate eligibility +
 * compute discount. The engine does not hit the DB; the caller assembles these.
 */
export type EnginePromotion = {
  id: string;
  mechanism: Mechanism;
  discountType: DiscountType;
  appliedTo: AppliedTo;
  config: PromotionConfig;
  scope: import('../promotions/schemas.js').Scope;
  stackableWith: string[];
  nonStackable: string[];
  /** Voucher code id that resolved to this promo (if any). Used in the audit trail. */
  voucherCodeId?: string | undefined;
};

/** Lightweight view of the clubbing matrix for the resolver. */
export type ClubbingRule = {
  appliedToA: AppliedTo;
  appliedToB: AppliedTo;
  defaultValue: ClubbingDefaultValue;
};

/** Loyalty tunables, read from platform_config. */
export type LoyaltyConfig = {
  pointValuePaise: number; // 100 = 1 point worth ₹1
  earnRateBp: number; // 10000 = 1 point per ₹1 spent
  minRedeemablePoints: number;
  /** 10000 = up to 100% of eligible amount. */
  maxRedeemFractionBp: number;
};

/** Per-method base delivery fee in paise. */
export type DeliveryFeeTable = Record<DeliveryMethod, number>;

export type EngineConfig = {
  loyalty: LoyaltyConfig;
  baseDeliveryFee: DeliveryFeeTable;
  surgeMultiplier: number; // 1.0 default
  /** Retailer overrides — set when the storefront has its own per-method fee. */
  deliveryOverridePaise?: number | undefined;
  handlingFeePaise?: number | undefined;
  convenienceFeePaise?: number | undefined;
  /** TCS basis points withheld per transaction (passthrough — surfaced in breakdown). */
  tcsRateBp: number;
};

/** Output of evaluating one promotion against the cart. */
export type EvaluatedPromotion = {
  promotion: EnginePromotion;
  /** Discount this promo would contribute, in paise. 0 means it didn't actually apply. */
  amountPaise: number;
  /**
   * Per-line allocation — the `amountPaise` distributed proportionally so invoicing can
   * later attribute discounts to specific items. Sum equals `amountPaise`.
   */
  perLinePaise: Record<string, number>;
  /** Why it didn't apply (if amountPaise === 0). */
  ineligibleReason?: string | undefined;
};

/** Final output of `compute(...)`. */
export type PricingBreakdown = {
  lineSubtotalPaise: number;
  /** Promotions that *actually* contributed a non-zero discount, post-clubbing resolution. */
  appliedPromotions: Array<{
    promotionId: string;
    mechanism: Mechanism;
    discountType: DiscountType;
    appliedTo: AppliedTo;
    amountPaise: number;
    voucherCodeId?: string | undefined;
  }>;
  /** Promotions that were considered but excluded (eligibility miss or clubbing conflict). */
  excludedPromotions: Array<{
    promotionId: string;
    reason: string;
  }>;
  retailerPromoDiscountPaise: number;
  platformPromoDiscountPaise: number;
  couponDiscountPaise: number;
  loyaltyDiscountPaise: number;
  shippingSubsidyPaise: number;
  postPromoSubtotalPaise: number;
  taxBasePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  deliveryFeePaise: number;
  handlingFeePaise: number;
  convenienceFeePaise: number;
  tcsPaise: number;
  /** Final amount the consumer pays. */
  totalPaise: number;
  /** Loyalty earned at this transaction (informational; recorded at delivery). */
  loyaltyEarnedPoints: number;
  /** Loyalty redeemed in this transaction (debited at order placement). */
  loyaltyRedeemedPoints: number;
};
