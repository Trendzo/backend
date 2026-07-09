/**
 * Cart-level quote — the multi-store analogue of `computeQuote`. Resolves a coupon +
 * loyalty-points redemption ONCE against the whole cart (across every store), then
 * SPLITS the discount + points across the per-store buckets so each child order can be
 * priced with its own share. The source of truth for BOTH `priceCart` (preview) and
 * `placeGroupOrder` (placement), so preview == placement.
 *
 * Per store i: `postPromo_i` = its bare subtotal after auto-promos (== line subtotal at
 * checkout, no auto-offers). Coupon splits weighted by each store's coupon-eligible
 * subtotal (last eligible store absorbs the rounding remainder → Σ exact). Points split
 * proportionally in WHOLE points, with a headroom waterfall so no child's coupon+points
 * exceeds its subtotal (→ each child's cap is a no-op, no drift; whole-point shares make
 * refund point-restoration exact). Wallet is NOT applied here — it draws greedily per
 * child at placement; the aggregate is the pre-wallet cart total.
 */
import { inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { compute } from '@/shared/discounts/compute.js';
import { eligibleLines } from '@/shared/discounts/eligibility.js';
import type { AppliedTo, ClubbingDefaultValue } from '@/shared/promotions/schemas.js';
import type { Cart, CartLine, ClubbingRule } from '@/shared/discounts/types.js';
import {
  computeQuote,
  resolveExplicitPromotions,
  type QuoteContext,
  type RejectedCode,
} from './compute-quote.js';

type CartItem = { variantId: string; qty: number };

export type CartQuoteBucket = {
  storeId: string;
  items: CartItem[];
  /** Final per-store quote WITH this bucket's pre-allocated coupon/points share applied. */
  quote: QuoteContext;
  preAllocated: {
    couponPaise: number;
    pointsPaise: number;
    couponPromotionId?: string;
    voucherCodeId?: string;
  };
};

export type CartQuoteResult = {
  buckets: CartQuoteBucket[];
  cartCouponPaise: number;
  cartPointsRedeemed: number;
  couponPromotionId?: string;
  voucherCodeId?: string;
  rejectedCodes: RejectedCode[];
  aggregate: {
    itemsSubtotalPaise: number;
    discountPaise: number;
    /** Split of `discountPaise` so the client can render honest line items. */
    mrpPromoPaise: number;
    couponPaise: number;
    pointsRedeemedPaise: number;
    deliveryFeePaise: number;
    taxPaise: number;
    grandTotalPaise: number;
    /** Wallet is a PARTIAL TENDER on top of grandTotal, not a discount. */
    walletAppliedPaise: number;
    /** grandTotalPaise − walletAppliedPaise → what the gateway/COD collects. */
    amountDuePaise: number;
    loyaltyEarnedPoints: number;
  };
};

export type CartQuoteInput = {
  consumerId?: string | undefined;
  items: CartItem[];
  deliveryMethod: 'express' | 'standard' | 'pickup' | 'try_and_buy';
  paymentMethod: 'upi' | 'card' | 'cod' | 'wallet' | 'gift_card';
  addressId?: string | undefined;
  couponCode?: string | undefined;
  voucherCode?: string | undefined;
  pointsToRedeem?: number | undefined;
  applyWallet?: boolean | undefined;
};

export async function computeCartQuote(
  database: typeof Db,
  input: CartQuoteInput,
): Promise<CartQuoteResult> {
  if (input.items.length === 0) {
    throw AppError.validation('At least one item is required');
  }

  // ── Bucket the cart by each variant's store (deterministic order) ──
  const variantIds = [...new Set(input.items.map((i) => i.variantId))];
  const rows = await database.query.variants.findMany({
    where: inArray(variants.id, variantIds),
    columns: { id: true, storeId: true },
  });
  const storeByVariant = new Map(rows.map((v) => [v.id, v.storeId]));
  const itemsByStore = new Map<string, CartItem[]>();
  for (const it of input.items) {
    const storeId = storeByVariant.get(it.variantId);
    if (!storeId) throw new AppError(404, ErrorCode.NotFound, `Unknown variant ${it.variantId}`);
    const list = itemsByStore.get(storeId) ?? [];
    list.push(it);
    itemsByStore.set(storeId, list);
  }
  const storeIds = [...itemsByStore.keys()].sort();

  // ── Bare per-store quote (no coupon/points) — gives the mergeable lines + weights ──
  const bareQuotes = new Map<string, QuoteContext>();
  for (const storeId of storeIds) {
    bareQuotes.set(
      storeId,
      await computeQuote(database, {
        ...(input.consumerId !== undefined && { consumerId: input.consumerId }),
        storeId,
        items: itemsByStore.get(storeId)!,
        deliveryMethod: input.deliveryMethod,
        paymentMethod: input.paymentMethod,
        ...(input.addressId !== undefined && { addressId: input.addressId }),
      }),
    );
  }
  const first = bareQuotes.get(storeIds[0]!)!;
  const consumer = first.consumer;
  const consumerLoyaltyBalance = first.consumerLoyaltyBalance;

  // ── Resolve the coupon/voucher ONCE against the merged cart ──
  const mergedLines: CartLine[] = [];
  for (const storeId of storeIds) mergedLines.push(...bareQuotes.get(storeId)!.cart.lines);
  const resolved = await resolveExplicitPromotions(database, {
    consumer: consumer ? { id: consumer.id } : null,
    isGuest: !consumer,
    ...(input.couponCode !== undefined && { couponCode: input.couponCode }),
    ...(input.voucherCode !== undefined && { voucherCode: input.voucherCode }),
    storeIdsInCart: storeIds,
    consumerLoyaltyBalance,
  });

  const clubbingRows = await database.query.clubbingMatrixEntries.findMany();
  const clubbingMatrix: ClubbingRule[] = clubbingRows.map((r) => ({
    appliedToA: r.appliedToA as AppliedTo,
    appliedToB: r.appliedToB as AppliedTo,
    defaultValue: r.defaultValue as ClubbingDefaultValue,
  }));
  const mergedCart: Cart = {
    consumerId: consumer?.id ?? 'guest',
    consumerStateCode: first.cart.consumerStateCode,
    storeStateCode: first.cart.storeStateCode,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    lines: mergedLines,
  };
  const mergedBreakdown = compute({
    cart: mergedCart,
    promotions: resolved.enginePromos,
    clubbingMatrix,
    config: first.engineConfig,
    pointsToRedeem: consumer ? (input.pointsToRedeem ?? 0) : 0,
    consumerLoyaltyBalance,
  });

  // rejectedCodes: gate rejections + explicit codes the engine couldn't apply.
  const rejectedCodes: RejectedCode[] = [...resolved.rejectedCodes];
  for (const [promoId, explicit] of resolved.explicitCodeByPromoId) {
    if (rejectedCodes.some((r) => r.code === explicit.code && r.kind === explicit.kind)) continue;
    const applied = mergedBreakdown.appliedPromotions.find((p) => p.promotionId === promoId);
    if (applied && applied.amountPaise > 0) continue;
    const excluded = mergedBreakdown.excludedPromotions.find((p) => p.promotionId === promoId);
    rejectedCodes.push({ ...explicit, reason: excluded?.reason ?? 'not_eligible' });
  }

  const cartCouponPaise = mergedBreakdown.couponDiscountPaise;
  const cartPointsRedeemed = mergedBreakdown.loyaltyRedeemedPoints;
  const couponPromo = resolved.enginePromos.find((p) => p.appliedTo === 'coupon');
  const couponPromotionId = couponPromo?.id;
  const pointValue = first.engineConfig.loyalty.pointValuePaise;

  // ── Coupon split — weighted by each store's coupon-eligible subtotal ──
  const eligSubtotalByStore = new Map<string, number>(storeIds.map((s) => [s, 0]));
  if (couponPromo && cartCouponPaise > 0) {
    for (const line of eligibleLines(couponPromo, mergedCart)) {
      const s = line.storeId;
      if (!s) continue;
      eligSubtotalByStore.set(s, (eligSubtotalByStore.get(s) ?? 0) + line.unitPricePaise * line.qty);
    }
  }
  const couponByStore = new Map<string, number>(storeIds.map((s) => [s, 0]));
  const eligStores = storeIds.filter((s) => (eligSubtotalByStore.get(s) ?? 0) > 0);
  const totalEligW = eligStores.reduce((sum, s) => sum + eligSubtotalByStore.get(s)!, 0);
  if (cartCouponPaise > 0 && totalEligW > 0) {
    let used = 0;
    eligStores.forEach((s, j) => {
      const share =
        j === eligStores.length - 1
          ? cartCouponPaise - used
          : Math.floor((cartCouponPaise * eligSubtotalByStore.get(s)!) / totalEligW);
      couponByStore.set(s, share);
      used += share;
    });
  }

  // ── Points split — proportional to postPromo, whole points, headroom waterfall ──
  const postPromoByStore = new Map<string, number>(
    storeIds.map((s) => [s, bareQuotes.get(s)!.breakdown.postPromoSubtotalPaise]),
  );
  const cartPostPromo = storeIds.reduce((sum, s) => sum + postPromoByStore.get(s)!, 0);
  const headroomPoints = new Map<string, number>(
    storeIds.map((s) => [
      s,
      Math.max(0, Math.floor((postPromoByStore.get(s)! - couponByStore.get(s)!) / pointValue)),
    ]),
  );
  const pointsByStore = new Map<string, number>(storeIds.map((s) => [s, 0]));
  let placedPts = 0;
  for (const s of storeIds) {
    const target =
      cartPostPromo > 0 ? Math.floor((cartPointsRedeemed * postPromoByStore.get(s)!) / cartPostPromo) : 0;
    const give = Math.min(target, headroomPoints.get(s)!);
    pointsByStore.set(s, give);
    placedPts += give;
  }
  let remaining = cartPointsRedeemed - placedPts;
  for (const s of storeIds) {
    if (remaining <= 0) break;
    const room = headroomPoints.get(s)! - pointsByStore.get(s)!;
    const give = Math.min(remaining, room);
    pointsByStore.set(s, pointsByStore.get(s)! + give);
    remaining -= give;
  }
  const actualCartPoints = cartPointsRedeemed - remaining;

  // ── Final per-store quote with the allocated share (exact tax/total; preview==placement) ──
  const buckets: CartQuoteBucket[] = [];
  for (const storeId of storeIds) {
    const couponPaise = couponByStore.get(storeId)!;
    const pointsPaise = pointsByStore.get(storeId)! * pointValue;
    const preAllocated: CartQuoteBucket['preAllocated'] = {
      couponPaise,
      pointsPaise,
      ...(couponPromotionId !== undefined && couponPaise > 0 && { couponPromotionId }),
      ...(resolved.voucherCodeId !== undefined && couponPaise > 0 && { voucherCodeId: resolved.voucherCodeId }),
    };
    const quote = await computeQuote(database, {
      ...(input.consumerId !== undefined && { consumerId: input.consumerId }),
      storeId,
      items: itemsByStore.get(storeId)!,
      deliveryMethod: input.deliveryMethod,
      paymentMethod: input.paymentMethod,
      ...(input.addressId !== undefined && { addressId: input.addressId }),
      preAllocated,
    });
    buckets.push({ storeId, items: itemsByStore.get(storeId)!, quote, preAllocated });
  }

  const aggregate = buckets.reduce(
    (a, b) => {
      const bd = b.quote.breakdown;
      const promo = bd.retailerPromoDiscountPaise + bd.platformPromoDiscountPaise;
      a.itemsSubtotalPaise += bd.lineSubtotalPaise;
      a.mrpPromoPaise += promo;
      a.couponPaise += bd.couponDiscountPaise;
      a.pointsRedeemedPaise += bd.loyaltyDiscountPaise;
      a.discountPaise += promo + bd.couponDiscountPaise + bd.loyaltyDiscountPaise;
      a.deliveryFeePaise += bd.deliveryFeePaise;
      a.taxPaise += bd.cgstPaise + bd.sgstPaise + bd.igstPaise;
      a.grandTotalPaise += bd.totalPaise;
      a.walletAppliedPaise += b.quote.walletAppliedPaise;
      a.loyaltyEarnedPoints += bd.loyaltyEarnedPoints;
      return a;
    },
    {
      itemsSubtotalPaise: 0,
      discountPaise: 0,
      mrpPromoPaise: 0,
      couponPaise: 0,
      pointsRedeemedPaise: 0,
      deliveryFeePaise: 0,
      taxPaise: 0,
      grandTotalPaise: 0,
      walletAppliedPaise: 0,
      loyaltyEarnedPoints: 0,
    },
  );
  const aggregateWithDue = { ...aggregate, amountDuePaise: aggregate.grandTotalPaise - aggregate.walletAppliedPaise };

  return {
    buckets,
    cartCouponPaise,
    cartPointsRedeemed: actualCartPoints,
    ...(couponPromotionId !== undefined && { couponPromotionId }),
    ...(resolved.voucherCodeId !== undefined && { voucherCodeId: resolved.voucherCodeId }),
    rejectedCodes,
    aggregate: aggregateWithDue,
  };
}
