import type { Cart, EnginePromotion } from './types.js';

/**
 * Filter cart lines down to the subset eligible for a given promotion's targeting scope.
 * Targeting drives WHICH lines a discount can attach to. Returns an empty array when
 * the promo targets no items in the cart.
 */
export function eligibleLines(promo: EnginePromotion, cart: Cart) {
  const s = promo.scope ?? {};
  return cart.lines.filter((line) => {
    // Store scope on a multi-store cart: a store-scoped coupon attaches only to lines
    // from an eligible store. On single-store carts `line.storeId` is unset and the
    // whole-promo store gate is enforced upstream (compute-quote), so this is a no-op.
    if (s.storeIds?.length && line.storeId && !s.storeIds.includes(line.storeId)) return false;
    // Inclusion lists — if any are set, line must match at least one inclusion check.
    const hasIncludes = !!(
      s.listingIds?.length ||
      s.variantIds?.length ||
      s.categoryIds?.length ||
      s.brandIds?.length
    );
    if (hasIncludes) {
      const matchListing = s.listingIds?.includes(line.listingId);
      const matchVariant = s.variantIds?.includes(line.variantId);
      const matchCategory = line.categoryId && s.categoryIds?.includes(line.categoryId);
      const matchBrand = line.brandId && s.brandIds?.includes(line.brandId);
      if (!matchListing && !matchVariant && !matchCategory && !matchBrand) return false;
    }
    // Exclusion lists.
    if (s.excludeListingIds?.includes(line.listingId)) return false;
    if (s.excludeVariantIds?.includes(line.variantId)) return false;
    if (line.categoryId && s.excludeCategoryIds?.includes(line.categoryId)) return false;
    if (line.brandId && s.excludeBrandIds?.includes(line.brandId)) return false;
    return true;
  });
}

/**
 * Cart-level eligibility checks (separate from line-level targeting). Returns null on
 * pass, or a short reason string if the promo is ineligible for this cart.
 */
export function ineligibilityReason(
  promo: EnginePromotion,
  cart: Cart,
  now: Date = new Date(),
): string | null {
  const s = promo.scope ?? {};

  // Day of week (0 = Sunday … 6 = Saturday)
  if (s.allowedDaysOfWeek?.length) {
    if (!s.allowedDaysOfWeek.includes(now.getDay())) return 'not_allowed_today';
  }
  // Time of day windows
  if (s.allowedTimesOfDay?.length) {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const inWindow = s.allowedTimesOfDay.some((w) => hhmm >= w.from && hhmm <= w.to);
    if (!inWindow) return 'outside_allowed_time';
  }
  // Region — consumer delivery state must be in the allowlist.
  if (s.allowedStateCodes?.length && !s.allowedStateCodes.includes(cart.consumerStateCode)) {
    return 'region_not_allowed';
  }
  // Delivery / payment method allowlists
  if (s.allowedDeliveryMethods?.length && !s.allowedDeliveryMethods.includes(cart.deliveryMethod)) {
    return 'delivery_method_disallowed';
  }
  if (s.allowedPaymentMethods?.length && !s.allowedPaymentMethods.includes(cart.paymentMethod)) {
    return 'payment_method_disallowed';
  }
  // Cart minimums
  const subtotal = cart.lines.reduce((s2, l) => s2 + l.unitPricePaise * l.qty, 0);
  if (s.minCartPaise != null && subtotal < s.minCartPaise) return 'cart_min_not_met';
  const itemCount = cart.lines.reduce((n, l) => n + l.qty, 0);
  if (s.minItemCount != null && itemCount < s.minItemCount) return 'item_count_min_not_met';
  // Specific consumer allow/deny
  if (s.specificConsumerIds?.length && !s.specificConsumerIds.includes(cart.consumerId)) {
    return 'consumer_not_targeted';
  }
  if (s.excludeConsumerIds?.includes(cart.consumerId)) return 'consumer_excluded';
  // Note: firstOrderOnly + loyaltyTierFilter need DB lookups upstream; engine doesn't enforce.
  return null;
}
