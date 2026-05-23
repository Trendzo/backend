/**
 * Tax base computation (MODULES.md §11).
 *
 * `tax_base = post_promo_subtotal - (coupon + loyalty)`, floored at 0.
 * Tax is computed against this, so a fully-discounted cart pays zero GST.
 */

export interface ComputeTaxBaseInput {
  postPromoSubtotalPaise: number;
  couponPaise: number;
  loyaltyPaise: number;
}

export function computeTaxBase(input: ComputeTaxBaseInput): number {
  return Math.max(
    0,
    input.postPromoSubtotalPaise - input.couponPaise - input.loyaltyPaise,
  );
}
