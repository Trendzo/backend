import type { LoyaltyConfig } from './types.js';

/**
 * Compute the loyalty redemption discount + the points actually consumed. Caller passes
 * the desired redemption (`pointsRequested`) and the eligible amount (post-promo, pre-tax
 * subtotal). Returns clamped points + paise — we never overrun caps.
 */
export function applyLoyaltyRedemption(input: {
  pointsRequested: number;
  consumerBalancePoints: number;
  eligibleSubtotalPaise: number;
  config: LoyaltyConfig;
}): { discountPaise: number; pointsRedeemed: number; clampedReason?: string } {
  const { pointsRequested, consumerBalancePoints, eligibleSubtotalPaise, config } = input;
  if (pointsRequested <= 0) {
    return { discountPaise: 0, pointsRedeemed: 0 };
  }
  if (pointsRequested < config.minRedeemablePoints) {
    return { discountPaise: 0, pointsRedeemed: 0, clampedReason: 'below_minimum' };
  }
  if (pointsRequested > consumerBalancePoints) {
    return { discountPaise: 0, pointsRedeemed: 0, clampedReason: 'exceeds_balance' };
  }
  // Cap by max redeem fraction of eligible subtotal.
  const capPaise = Math.floor((eligibleSubtotalPaise * config.maxRedeemFractionBp) / 10000);
  const requestedPaise = pointsRequested * config.pointValuePaise;
  if (requestedPaise <= capPaise) {
    return { discountPaise: requestedPaise, pointsRedeemed: pointsRequested };
  }
  // Clamp to cap; only redeem the points worth the cap.
  const allowedPoints = Math.floor(capPaise / config.pointValuePaise);
  return {
    discountPaise: allowedPoints * config.pointValuePaise,
    pointsRedeemed: allowedPoints,
    clampedReason: 'exceeds_cap',
  };
}

/**
 * Compute loyalty points earned on this transaction. Per spec line 836: post-discount,
 * pre-tax subtotal × earnRateBp/10000. Floor to integer.
 */
export function loyaltyEarned(postDiscountPreTaxPaise: number, config: LoyaltyConfig): number {
  if (postDiscountPreTaxPaise <= 0) return 0;
  return Math.floor((postDiscountPreTaxPaise * config.earnRateBp) / 10000 / config.pointValuePaise);
}
