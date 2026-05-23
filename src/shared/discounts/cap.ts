/**
 * Discount cap rule (MODULES.md §11).
 *
 * The coupon + loyalty discounts combined cannot exceed `post_promo_subtotal`,
 * otherwise the grand total would go negative. The cap is applied symmetrically:
 * coupon clamps first, then loyalty against the remaining headroom.
 */

export interface ApplyDiscountCapInput {
  postPromoSubtotalPaise: number;
  couponPaise: number;
  loyaltyPaise: number;
}

export interface ApplyDiscountCapOutput {
  cappedCouponPaise: number;
  cappedLoyaltyPaise: number;
  /** True when at least one input was reduced. */
  wasClamped: boolean;
}

export function applyDiscountCap(input: ApplyDiscountCapInput): ApplyDiscountCapOutput {
  const cappedCouponPaise = Math.min(input.couponPaise, input.postPromoSubtotalPaise);
  const headroom = Math.max(0, input.postPromoSubtotalPaise - cappedCouponPaise);
  const cappedLoyaltyPaise = Math.min(input.loyaltyPaise, headroom);
  const wasClamped =
    cappedCouponPaise !== input.couponPaise || cappedLoyaltyPaise !== input.loyaltyPaise;
  return { cappedCouponPaise, cappedLoyaltyPaise, wasClamped };
}
