/**
 * Pricing engine orchestrator. Runs the full pricing layer order from PRODUCT_SPEC
 * line 554–572:
 *
 *   line_subtotal
 *     − retailer_promo_discount
 *     − platform_promo_discount
 *   = post_promo_subtotal
 *     − coupon_discount
 *     − loyalty_discount
 *   = tax_base (floored at 0)
 *     + GST (intra/inter-state)
 *     + delivery (overridable)
 *     + handling + convenience
 *   = total
 */
import {
  applyBogo,
  applyBundle,
  applyBxgy,
  applyFlatAmount,
  applyFreeShipping,
  applyPercent,
  applyPercentUpto,
  applyTieredCart,
} from './discount-types.js';
import type {
  BogoConfig,
  BundleConfig,
  BxgyConfig,
  FlatAmountConfig,
  FreeShippingConfig,
  PercentConfig,
  PercentUptoConfig,
  TieredCartConfig,
} from '../promotions/schemas.js';
import { eligibleLines, ineligibilityReason } from './eligibility.js';
import { resolveClubbing } from './clubbing.js';
import { applyLoyaltyRedemption, loyaltyEarned } from './loyalty.js';
import { gstSplit, tcsWithheld } from './tax.js';
import { applyDiscountCap } from './cap.js';
import { computeTaxBase } from './tax-base.js';
import type {
  Cart,
  ClubbingRule,
  EngineConfig,
  EnginePromotion,
  EvaluatedPromotion,
  PricingBreakdown,
} from './types.js';

export type ComputeInput = {
  cart: Cart;
  promotions: EnginePromotion[];
  clubbingMatrix: ClubbingRule[];
  config: EngineConfig;
  /** Loyalty points the consumer wants to redeem (0 = none). */
  pointsToRedeem?: number;
  /** Their current points balance (used to clamp). */
  consumerLoyaltyBalance?: number;
  /**
   * Group child only: this child's pre-allocated coupon + loyalty share (paise),
   * resolved once against the whole cart and split across children. When set, the
   * engine injects these instead of deriving the coupon from `promotions` or running
   * loyalty redemption (child gets no coupon promo + `pointsToRedeem=0`). The single
   * counter-bump + points-debit happen once at group level.
   */
  preAllocated?: { couponPaise: number; loyaltyPaise: number } | undefined;
};

export function compute(input: ComputeInput): PricingBreakdown {
  const { cart, promotions, clubbingMatrix, config } = input;

  const lineSubtotalPaise = cart.lines.reduce(
    (s, l) => s + l.unitPricePaise * l.qty,
    0,
  );

  // 1. Evaluate every promotion against the cart.
  const evaluations: EvaluatedPromotion[] = [];
  const excluded: Array<{ promotionId: string; reason: string }> = [];

  for (const promo of promotions) {
    const cartReason = ineligibilityReason(promo, cart);
    if (cartReason) {
      excluded.push({ promotionId: promo.id, reason: cartReason });
      continue;
    }
    const lines = eligibleLines(promo, cart);
    if (lines.length === 0) {
      excluded.push({ promotionId: promo.id, reason: 'no_eligible_lines' });
      continue;
    }
    let result: { amountPaise: number; perLinePaise: Record<string, number> };
    switch (promo.discountType) {
      case 'flat_amount':
        result = applyFlatAmount(lines, promo.config as FlatAmountConfig);
        break;
      case 'percent':
        result = applyPercent(lines, promo.config as PercentConfig);
        break;
      case 'percent_upto':
        result = applyPercentUpto(lines, promo.config as PercentUptoConfig);
        break;
      case 'bogo':
        result = applyBogo(lines, promo.config as BogoConfig);
        break;
      case 'bxgy':
        result = applyBxgy(lines, promo.config as BxgyConfig);
        break;
      case 'bundle':
        result = applyBundle(lines, promo.config as BundleConfig);
        break;
      case 'tiered_cart':
        result = applyTieredCart(lines, promo.config as TieredCartConfig);
        break;
      case 'free_shipping':
        result = applyFreeShipping(lines, promo.config as FreeShippingConfig);
        break;
    }
    if (result.amountPaise <= 0) {
      excluded.push({ promotionId: promo.id, reason: 'no_discount_produced' });
      continue;
    }
    evaluations.push({ promotion: promo, ...result });
  }

  // 2. Resolve clubbing — keep the maximal mutually-compatible subset.
  const { kept, rejected } = resolveClubbing(evaluations, clubbingMatrix);
  for (const r of rejected) {
    excluded.push({ promotionId: r.promotion.promotion.id, reason: r.reason });
  }

  // 3. Bucket the kept discounts by clubbing slot for the breakdown.
  let retailerPromoDiscountPaise = 0;
  let platformPromoDiscountPaise = 0;
  let couponDiscountPaise = 0;
  let shippingSubsidyPaise = 0;

  for (const e of kept) {
    if (e.promotion.appliedTo === 'shipping') {
      // Compute the actual subsidy from the eligible delivery fee.
      const baseFee =
        config.deliveryOverridePaise ??
        Math.floor(config.baseDeliveryFee[cart.deliveryMethod] * config.surgeMultiplier);
      shippingSubsidyPaise = baseFee;
    } else if (e.promotion.appliedTo === 'coupon') {
      couponDiscountPaise += e.amountPaise;
    } else if (e.promotion.appliedTo === 'retailer_promo') {
      retailerPromoDiscountPaise += e.amountPaise;
    } else if (e.promotion.appliedTo === 'platform_promo') {
      platformPromoDiscountPaise += e.amountPaise;
    }
  }

  // Group child: inject this child's pre-allocated coupon share (the coupon was
  // resolved once against the whole cart; the child carries no coupon promo).
  if (input.preAllocated) {
    couponDiscountPaise = input.preAllocated.couponPaise;
  }

  // 4. Subtotals.
  const postPromoSubtotalPaise = Math.max(
    0,
    lineSubtotalPaise - retailerPromoDiscountPaise - platformPromoDiscountPaise,
  );

  // 5. Loyalty redemption — applied on top, NOT subject to clubbing (per spec line 778).
  //    Uses the *uncapped* coupon discount for headroom; the cap rule clamps both
  //    coupon + loyalty after the redemption math runs. A group child injects its
  //    pre-allocated loyalty share (points debited once at group level → 0 here).
  const loyalty = input.preAllocated
    ? { pointsRedeemed: 0, discountPaise: input.preAllocated.loyaltyPaise }
    : applyLoyaltyRedemption({
        pointsRequested: input.pointsToRedeem ?? 0,
        consumerBalancePoints: input.consumerLoyaltyBalance ?? 0,
        eligibleSubtotalPaise: Math.max(0, postPromoSubtotalPaise - couponDiscountPaise),
        config: config.loyalty,
      });
  const loyaltyRedeemedPoints = loyalty.pointsRedeemed;

  // 6. Discount cap rule (§11). Coupon + loyalty cannot exceed post-promo subtotal.
  const capped = applyDiscountCap({
    postPromoSubtotalPaise,
    couponPaise: couponDiscountPaise,
    loyaltyPaise: loyalty.discountPaise,
  });
  const cappedCouponDiscountPaise = capped.cappedCouponPaise;
  const loyaltyDiscountPaise = capped.cappedLoyaltyPaise;

  // 7. Tax base — floored at 0 via shared helper (§11).
  const taxBasePaise = computeTaxBase({
    postPromoSubtotalPaise,
    couponPaise: cappedCouponDiscountPaise,
    loyaltyPaise: loyaltyDiscountPaise,
  });

  const { cgstPaise, sgstPaise, igstPaise } = gstSplit(
    taxBasePaise,
    cart.lines,
    cart.consumerStateCode,
    cart.storeStateCode,
  );

  // 7. Delivery + fees.
  const baseDelivery =
    config.deliveryOverridePaise ??
    Math.floor(config.baseDeliveryFee[cart.deliveryMethod] * config.surgeMultiplier);
  const deliveryFeePaise = Math.max(0, baseDelivery - shippingSubsidyPaise);
  const handlingFeePaise = config.handlingFeePaise ?? 0;
  const convenienceFeePaise = config.convenienceFeePaise ?? 0;

  const tcsPaise = tcsWithheld(taxBasePaise, config.tcsRateBp);

  // 8. Total. (TCS is informational — not added to consumer's bill; held from retailer payout.)
  const totalPaise =
    taxBasePaise +
    cgstPaise +
    sgstPaise +
    igstPaise +
    deliveryFeePaise +
    handlingFeePaise +
    convenienceFeePaise;

  // 9. Loyalty earned — informational (recorded at delivery per spec).
  const loyaltyEarnedPoints = loyaltyEarned(taxBasePaise, config.loyalty);

  return {
    lineSubtotalPaise,
    appliedPromotions: kept.map((e) => ({
      promotionId: e.promotion.id,
      mechanism: e.promotion.mechanism,
      discountType: e.promotion.discountType,
      appliedTo: e.promotion.appliedTo,
      amountPaise:
        e.promotion.appliedTo === 'shipping' ? shippingSubsidyPaise : e.amountPaise,
      ...(e.promotion.voucherCodeId !== undefined && { voucherCodeId: e.promotion.voucherCodeId }),
    })),
    excludedPromotions: excluded,
    retailerPromoDiscountPaise,
    platformPromoDiscountPaise,
    couponDiscountPaise: cappedCouponDiscountPaise,
    loyaltyDiscountPaise,
    shippingSubsidyPaise,
    postPromoSubtotalPaise,
    taxBasePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    deliveryFeePaise,
    handlingFeePaise,
    convenienceFeePaise,
    tcsPaise,
    totalPaise,
    loyaltyEarnedPoints,
    loyaltyRedeemedPoints,
  };
}
