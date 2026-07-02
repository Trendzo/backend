/**
 * Quote computation — the read-only / pure half of order placement.
 *
 * Everything here happens BEFORE the placement transaction: load consumer/store/
 * address/variants, resolve coupons/vouchers/promotions (gates G1/G2/G4 + store
 * gating), run the pure pricing engine, allocate discounts to lines, and read
 * (without reserving) per-variant stock availability.
 *
 * `placeOrder` calls this to get its pre-transaction context, and the consumer
 * `/checkout/quote` endpoint calls it directly for a dry-run. Sharing this path is
 * what guarantees the quoted total equals the final placed total — no drift.
 *
 * NOTE: this function does NOT reserve stock. The `stock[].ok` flags are advisory
 * (a snapshot read); the authoritative guard is the atomic reserve inside the
 * placement transaction.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  addresses,
  consumers,
  consumerWallets,
  consumerLoyalty,
  orders,
  platformConfig,
  promotions,
  retailerStores,
  variants,
  voucherCodes,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { compute } from '@/shared/discounts/compute.js';
import { resolveGstRateBp } from '@/shared/pos/gst-rates.js';
import type {
  Cart,
  CartLine,
  EngineConfig,
  EnginePromotion,
  PricingBreakdown,
} from '@/shared/discounts/types.js';
import type {
  AppliedTo,
  ClubbingDefaultValue,
  DiscountType,
  Mechanism,
  PromotionConfig,
  Scope,
} from '@/shared/promotions/schemas.js';

export type QuoteInput = {
  /** Omit for a guest/preview quote (no loyalty redeem, no wallet, no per-consumer gates). */
  consumerId?: string | undefined;
  storeId: string;
  /** One per variant; qty must be positive. */
  items: Array<{ variantId: string; qty: number }>;
  deliveryMethod: 'express' | 'standard' | 'pickup' | 'try_and_buy';
  paymentMethod: 'upi' | 'card' | 'cod' | 'wallet' | 'gift_card';
  addressId?: string | undefined;
  couponCode?: string | undefined;
  voucherCode?: string | undefined;
  pointsToRedeem?: number | undefined;
  /** Apply wallet balance as a partial tender alongside `paymentMethod`. */
  applyWallet?: boolean | undefined;
};

export type StockLine = {
  variantId: string;
  available: number;
  required: number;
  ok: boolean;
};

/** An explicit coupon/voucher code that could not be applied — surfaced, never thrown. */
export type RejectedCode = { code: string; kind: 'coupon' | 'voucher'; reason: string };

/** Per-line priced output — everything the client needs to render a line with zero math. */
export type PricedLine = {
  variantId: string;
  listingId: string;
  name: string;
  attributesLabel: string;
  imageUrl: string | null;
  qty: number;
  unitPricePaise: number;
  grossPaise: number;
  discountAllocPaise: number;
  taxAllocPaise: number;
  netLinePaise: number;
};

export type DeliveryMethodKey = 'express' | 'standard' | 'pickup' | 'try_and_buy';

/** Per-method delivery fee (what the engine would charge for each) — drives the picker. */
export function deliveryOptionsFromConfig(cfg: EngineConfig): Record<DeliveryMethodKey, number> {
  const feeFor = (m: DeliveryMethodKey) =>
    cfg.deliveryOverridePaise ?? Math.floor(cfg.baseDeliveryFee[m] * cfg.surgeMultiplier);
  return {
    express: feeFor('express'),
    standard: feeFor('standard'),
    pickup: feeFor('pickup'),
    try_and_buy: feeFor('try_and_buy'),
  };
}

// Normalise an engine/orchestrator exclusion reason for a rejected explicit code.
// Consumer-targeted misses become `requires_login` for guests (they may qualify once signed in).
function normalizeReason(reason: string, isGuest: boolean): string {
  if (isGuest && (reason === 'consumer_not_targeted' || reason === 'consumer_excluded')) {
    return 'requires_login';
  }
  return reason;
}

/**
 * How much wallet to apply as tender. Wallet is a PARTIAL tender (not a discount):
 * it covers part or all of the order total, the remainder going on `paymentMethod`.
 * Triggered by an explicit wallet-only method or the `applyWallet` opt-in. Clamped
 * to the available balance and the order total. Pure — no throw; the wallet-only
 * full-cover requirement is enforced transactionally in placeOrder.
 */
export function resolveWalletApplyPaise(args: {
  paymentMethod: QuoteInput['paymentMethod'];
  applyWallet: boolean | undefined;
  balancePaise: number;
  totalPaise: number;
}): number {
  const wantsWallet = args.paymentMethod === 'wallet' || args.applyWallet === true;
  if (!wantsWallet) return 0;
  return Math.max(0, Math.min(args.balancePaise, args.totalPaise));
}

/**
 * Resolve + price a cart without writing anything. Returns the pricing breakdown
 * plus every entity `placeOrder` needs downstream, so placement does not re-query.
 *
 * Return type is inferred (not hand-annotated) so callers get precise types for the
 * loaded rows (consumer/store/address/variant relations).
 */
export async function computeQuote(database: typeof Db, input: QuoteInput) {
  const isGuest = !input.consumerId;
  const rejectedCodes: RejectedCode[] = [];

  // ── Pre-load static data (consumer, store, address, items) ──
  // Consumer is optional: a guest/preview quote skips loyalty, wallet, and all
  // per-consumer promo gates. Placement always passes a real consumerId.
  const consumer = input.consumerId
    ? await database.query.consumers.findFirst({ where: eq(consumers.id, input.consumerId) })
    : null;
  if (input.consumerId && !consumer) {
    throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  }

  const store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.id, input.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  if (store.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.OrderStoreUnavailable,
      `Store ${input.storeId} is not active (status='${store.status}')`,
    );
  }

  let address: typeof addresses.$inferSelect | undefined;
  if (input.addressId) {
    address = await database.query.addresses.findFirst({
      where: eq(addresses.id, input.addressId),
    });
    if (!address) throw new AppError(404, ErrorCode.NotFound, 'Address not found');
  } else if (input.deliveryMethod !== 'pickup' && consumer) {
    // Fall back to the consumer's default address when caller omits addressId.
    // Guests have no address → GST falls back to the store state (intra-state) below.
    address = await database.query.addresses.findFirst({
      where: and(eq(addresses.consumerId, consumer.id), eq(addresses.isDefault, true)),
    });
  }

  if (input.items.length === 0) {
    throw AppError.validation('At least one item is required');
  }

  // Try-and-Buy is prepaid only — payment must clear before agent doors-up the order.
  // COD on a try-on order would mean settling cash at the door for items the customer
  // can still refuse, which is operationally infeasible.
  if (input.deliveryMethod === 'try_and_buy' && input.paymentMethod === 'cod') {
    throw new AppError(
      400,
      ErrorCode.ValidationError,
      'Try-and-Buy orders are prepaid only — COD is not allowed',
    );
  }

  const variantIds = input.items.map((i) => i.variantId);
  const variantRows = await database.query.variants.findMany({
    where: inArray(variants.id, variantIds),
    with: {
      listing: {
        with: { brand: true, category: true },
      },
    },
  });
  if (variantRows.length !== variantIds.length) {
    throw new AppError(404, ErrorCode.NotFound, 'One or more variants not found');
  }
  // Ensure every variant belongs to the chosen store, its listing is live, and
  // the variant itself is published (isActive). An unpublished variant/SKU or a
  // non-active listing must not be purchasable.
  for (const v of variantRows) {
    if (v.listing.storeId !== input.storeId) {
      throw AppError.validation(
        `Variant ${v.id} belongs to a different store than the chosen store`,
      );
    }
    if (v.listing.status !== 'active') {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Product "${v.listing.name}" is not available for purchase`,
      );
    }
    if (!v.isActive) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Variant "${v.attributesLabel}" is not available for purchase`,
      );
    }
  }

  // ── Build the cart for the pricing engine ──
  const variantById = new Map(variantRows.map((v) => [v.id, v]));
  const cartLines: CartLine[] = input.items.map((it) => {
    const v = variantById.get(it.variantId)!;
    const line: CartLine = {
      lineId: v.id,
      listingId: v.listing.id,
      variantId: v.id,
      unitPricePaise: v.pricePaise,
      qty: it.qty,
      // Same authoritative GST table as the POS counter — rate from HSN/category, GST 2.0 slabs.
      gstRatePct:
        resolveGstRateBp({
          hsn: v.listing.hsn,
          categorySlug: v.listing.category?.slug ?? null,
          unitMrpPaise: v.pricePaise,
        }) / 100,
    };
    if (v.listing.brandId) line.brandId = v.listing.brandId;
    if (v.listing.categoryId) line.categoryId = v.listing.categoryId;
    return line;
  });

  const cart: Cart = {
    consumerId: consumer?.id ?? 'guest',
    consumerStateCode: address?.stateCode ?? store.stateCode,
    storeStateCode: store.stateCode,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    lines: cartLines,
  };

  // ── Resolve promotions (explicit coupon/voucher only; auto-offers out of scope) ──
  // No throws: an unusable explicit code is recorded in `rejectedCodes` and the cart
  // is priced WITHOUT it, so a bad coupon can never block a quote or a placement.
  const promoIds = new Set<string>();
  const explicitCodeByPromoId = new Map<string, { code: string; kind: 'coupon' | 'voucher' }>();
  let voucherCodeId: string | undefined;
  let voucherCodePromotionId: string | undefined;

  if (input.couponCode) {
    const promo = await database.query.promotions.findFirst({
      where: and(eq(promotions.name, input.couponCode), eq(promotions.mechanism, 'coupon')),
    });
    if (!promo) {
      rejectedCodes.push({ code: input.couponCode, kind: 'coupon', reason: 'not_found' });
    } else {
      promoIds.add(promo.id);
      explicitCodeByPromoId.set(promo.id, { code: input.couponCode, kind: 'coupon' });
    }
  }

  if (input.voucherCode) {
    const code = await database.query.voucherCodes.findFirst({
      where: eq(voucherCodes.code, input.voucherCode.toUpperCase()),
    });
    if (!code) {
      rejectedCodes.push({ code: input.voucherCode, kind: 'voucher', reason: 'not_found' });
    } else if (code.totalUses != null && code.redeemedCount >= code.totalUses) {
      rejectedCodes.push({ code: input.voucherCode, kind: 'voucher', reason: 'fully_redeemed' });
    } else if (code.assignedConsumerId && (isGuest || code.assignedConsumerId !== consumer!.id)) {
      // §13 P6 — targeted vouchers are reserved for a specific consumer.
      rejectedCodes.push({
        code: input.voucherCode,
        kind: 'voucher',
        reason: isGuest ? 'requires_login' : 'assigned_to_other',
      });
    } else {
      promoIds.add(code.promotionId);
      explicitCodeByPromoId.set(code.promotionId, { code: input.voucherCode, kind: 'voucher' });
      voucherCodeId = code.id;
      voucherCodePromotionId = code.promotionId;
    }
  }

  const promoRows =
    promoIds.size === 0
      ? []
      : await database.query.promotions.findMany({
          where: inArray(promotions.id, [...promoIds]),
        });

  // G1: Validate status and validity window. Unusable explicit codes → rejectedCodes.
  const now = new Date();
  const validPromoRows = promoRows.filter((p) => {
    const isActive = p.status === 'active';
    const inWindow = p.validFrom <= now && p.validUntil >= now;
    if (!isActive || !inWindow) {
      const explicit = explicitCodeByPromoId.get(p.id);
      if (explicit) {
        rejectedCodes.push({ ...explicit, reason: !isActive ? 'inactive' : 'expired' });
      }
      return false;
    }
    return true;
  });

  const enginePromos: EnginePromotion[] = validPromoRows.map((p) => {
    const promo: EnginePromotion = {
      id: p.id,
      mechanism: p.mechanism as Mechanism,
      discountType: p.discountType as DiscountType,
      appliedTo: p.appliedTo as AppliedTo,
      config: p.config as unknown as PromotionConfig,
      scope: p.scope as unknown as Scope,
      stackableWith: p.stackableWith,
      nonStackable: p.nonStackable,
    };
    if (voucherCodeId && p.id === voucherCodePromotionId) {
      promo.voucherCodeId = voucherCodeId;
    }
    return promo;
  });

  // Loyalty balance — consumer only (used for redemption math + tier checks). Guest = 0.
  const loyaltyAcct = consumer
    ? await database.query.consumerLoyalty.findFirst({
        where: eq(consumerLoyalty.consumerId, consumer.id),
      })
    : null;
  const consumerLoyaltyBalance = loyaltyAcct?.balancePoints ?? 0;

  // G2: firstOrderOnly — only meaningful for a signed-in consumer with prior orders.
  // Guests are first-time by definition, so these promos stay.
  if (consumer && enginePromos.some((p) => p.scope?.firstOrderOnly)) {
    const priorOrder = await database.query.orders.findFirst({
      where: and(eq(orders.consumerId, consumer.id), sql`${orders.status} != 'payment_failed'`),
      columns: { id: true },
    });
    if (priorOrder) {
      for (let i = enginePromos.length - 1; i >= 0; i--) {
        if (!enginePromos[i]!.scope?.firstOrderOnly) continue;
        const explicit = explicitCodeByPromoId.get(enginePromos[i]!.id);
        if (explicit) rejectedCodes.push({ ...explicit, reason: 'first_order_only' });
        enginePromos.splice(i, 1);
      }
    }
  }

  // G4: Enforce loyaltyTierFilter — derive consumer tier (guest = bronze).
  if (enginePromos.some((p) => p.scope?.loyaltyTierFilter?.length)) {
    const tierCfg = await database.query.platformConfig.findMany({
      where: inArray(platformConfig.key, [
        'loyalty_tier_silver_min',
        'loyalty_tier_gold_min',
        'loyalty_tier_platinum_min',
      ]),
    });
    const silver = (tierCfg.find((c) => c.key === 'loyalty_tier_silver_min')?.value as number | undefined) ?? 500;
    const gold   = (tierCfg.find((c) => c.key === 'loyalty_tier_gold_min')?.value   as number | undefined) ?? 2000;
    const plat   = (tierCfg.find((c) => c.key === 'loyalty_tier_platinum_min')?.value as number | undefined) ?? 5000;
    const consumerTier: 'bronze' | 'silver' | 'gold' | 'platinum' =
      consumerLoyaltyBalance >= plat ? 'platinum'
        : consumerLoyaltyBalance >= gold ? 'gold'
        : consumerLoyaltyBalance >= silver ? 'silver'
        : 'bronze';
    for (let i = enginePromos.length - 1; i >= 0; i--) {
      const filter = enginePromos[i]!.scope?.loyaltyTierFilter;
      if (filter?.length && !filter.includes(consumerTier)) {
        const explicit = explicitCodeByPromoId.get(enginePromos[i]!.id);
        if (explicit) rejectedCodes.push({ ...explicit, reason: 'tier_ineligible' });
        enginePromos.splice(i, 1);
      }
    }
  }

  // §13 A5 — scope.storeIds gating (cart represents one store). Unusable explicit
  // codes → rejectedCodes; auto-applied offers silently drop.
  for (let i = enginePromos.length - 1; i >= 0; i--) {
    const storeIds = enginePromos[i]!.scope?.storeIds;
    if (storeIds?.length && !storeIds.includes(store.id)) {
      const explicit = explicitCodeByPromoId.get(enginePromos[i]!.id);
      if (explicit) rejectedCodes.push({ ...explicit, reason: 'store_ineligible' });
      enginePromos.splice(i, 1);
    }
  }

  const clubbingRows = await database.query.clubbingMatrixEntries.findMany();
  const clubbingMatrix = clubbingRows.map((r) => ({
    appliedToA: r.appliedToA as AppliedTo,
    appliedToB: r.appliedToB as AppliedTo,
    defaultValue: r.defaultValue as ClubbingDefaultValue,
  }));

  const engineConfig = await loadEngineConfig(database, store);

  const breakdown = compute({
    cart,
    promotions: enginePromos,
    clubbingMatrix,
    config: engineConfig,
    // Guests can't redeem loyalty (no balance / no account).
    pointsToRedeem: isGuest ? 0 : (input.pointsToRedeem ?? 0),
    consumerLoyaltyBalance,
  });

  // Explicit codes that survived gating but the engine still couldn't apply
  // (clubbing conflict, cart minimum, consumer targeting, no-match) → rejectedCodes.
  for (const [promoId, explicit] of explicitCodeByPromoId) {
    if (rejectedCodes.some((r) => r.code === explicit.code && r.kind === explicit.kind)) continue;
    const applied = breakdown.appliedPromotions.find((p) => p.promotionId === promoId);
    if (applied && applied.amountPaise > 0) continue; // genuinely applied
    const excluded = breakdown.excludedPromotions.find((p) => p.promotionId === promoId);
    rejectedCodes.push({
      ...explicit,
      reason: normalizeReason(excluded?.reason ?? 'not_eligible', isGuest),
    });
  }

  // ── Per-item allocations (proportional to line subtotal) ──
  const lineAllocations = allocateDiscountsToLines(cartLines, breakdown);

  // ── Per-line priced output (zero math on the client) ──
  const lines: PricedLine[] = cartLines.map((l) => {
    const v = variantById.get(l.variantId)!;
    const alloc = lineAllocations.get(l.lineId)!;
    const grossPaise = l.unitPricePaise * l.qty;
    const discountAllocPaise = alloc.retailerPromo + alloc.platformPromo + alloc.coupon + alloc.points;
    return {
      variantId: l.variantId,
      listingId: l.listingId,
      name: v.listing.name,
      attributesLabel: v.attributesLabel,
      imageUrl: v.imageUrls?.[0] ?? v.listing.galleryUrls?.[0] ?? null,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
      grossPaise,
      discountAllocPaise,
      taxAllocPaise: alloc.gst,
      netLinePaise: grossPaise - discountAllocPaise + alloc.gst,
    };
  });

  const deliveryOptions = deliveryOptionsFromConfig(engineConfig);

  // ── Read-only stock availability (advisory; the tx reserve is the real guard) ──
  const stock: StockLine[] = input.items.map((it) => {
    const v = variantById.get(it.variantId)!;
    const available = v.stock - v.reserved;
    return {
      variantId: it.variantId,
      available,
      required: it.qty,
      ok: available >= it.qty,
    };
  });

  // ── Wallet tender (advisory; placeOrder re-reads + debits under CAS) ──
  // Guests have no wallet.
  const walletRow = consumer
    ? await database.query.consumerWallets.findFirst({
        where: eq(consumerWallets.consumerId, consumer.id),
      })
    : null;
  const walletBalancePaise = walletRow?.balancePaise ?? 0;
  const walletAppliedPaise = isGuest
    ? 0
    : resolveWalletApplyPaise({
        paymentMethod: input.paymentMethod,
        applyWallet: input.applyWallet,
        balancePaise: walletBalancePaise,
        totalPaise: breakdown.totalPaise,
      });
  const amountDuePaise = breakdown.totalPaise - walletAppliedPaise;

  return {
    consumer,
    store,
    address,
    variantById,
    cart,
    enginePromos,
    consumerLoyaltyBalance,
    engineConfig,
    breakdown,
    lineAllocations,
    lines,
    deliveryOptions,
    rejectedCodes,
    stock,
    walletBalancePaise,
    walletAppliedPaise,
    amountDuePaise,
  };
}

/** Full pre-transaction context produced by {@link computeQuote}. */
export type QuoteContext = Awaited<ReturnType<typeof computeQuote>>;

// ─────────────── helpers (moved from place-order.ts; shared by quote + placement) ───────────────

export type LineAllocation = {
  retailerPromo: number;
  platformPromo: number;
  coupon: number;
  points: number;
  gst: number;
};

/**
 * Allocate aggregate discounts + tax to individual lines proportionally to line subtotal.
 * Last line picks up rounding crumbs so totals reconcile.
 */
export function allocateDiscountsToLines(
  lines: CartLine[],
  breakdown: PricingBreakdown,
): Map<string, LineAllocation> {
  const totalSubtotal = lines.reduce((s, l) => s + l.unitPricePaise * l.qty, 0);
  const totalGst = breakdown.cgstPaise + breakdown.sgstPaise + breakdown.igstPaise;
  const out = new Map<string, LineAllocation>();
  let usedRetailer = 0;
  let usedPlatform = 0;
  let usedCoupon = 0;
  let usedPoints = 0;
  let usedGst = 0;

  lines.forEach((l, idx) => {
    const lineSubtotal = l.unitPricePaise * l.qty;
    const isLast = idx === lines.length - 1;
    const share = totalSubtotal === 0 ? 0 : lineSubtotal / totalSubtotal;
    const alloc: LineAllocation = {
      retailerPromo: isLast
        ? breakdown.retailerPromoDiscountPaise - usedRetailer
        : Math.floor(breakdown.retailerPromoDiscountPaise * share),
      platformPromo: isLast
        ? breakdown.platformPromoDiscountPaise - usedPlatform
        : Math.floor(breakdown.platformPromoDiscountPaise * share),
      coupon: isLast
        ? breakdown.couponDiscountPaise - usedCoupon
        : Math.floor(breakdown.couponDiscountPaise * share),
      points: isLast
        ? breakdown.loyaltyDiscountPaise - usedPoints
        : Math.floor(breakdown.loyaltyDiscountPaise * share),
      gst: isLast ? totalGst - usedGst : Math.floor(totalGst * share),
    };
    usedRetailer += alloc.retailerPromo;
    usedPlatform += alloc.platformPromo;
    usedCoupon += alloc.coupon;
    usedPoints += alloc.points;
    usedGst += alloc.gst;
    out.set(l.lineId, alloc);
  });
  return out;
}

export async function loadEngineConfig(
  database: typeof Db,
  store: typeof retailerStores.$inferSelect,
): Promise<EngineConfig> {
  const keys = [
    'loyalty_point_value_paise',
    'loyalty_earn_rate_bp',
    'min_redeemable_points',
    'max_redeem_fraction_bp',
    'base_delivery_fee_table',
    'surge_multiplier',
    'tcs_rate_bp',
  ];
  const rows = await database.query.platformConfig.findMany({
    where: inArray(platformConfig.key, keys),
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const cfg: EngineConfig = {
    loyalty: {
      pointValuePaise: (map.get('loyalty_point_value_paise') as number) ?? 100,
      earnRateBp: (map.get('loyalty_earn_rate_bp') as number) ?? 10000,
      minRedeemablePoints: (map.get('min_redeemable_points') as number) ?? 100,
      maxRedeemFractionBp: (map.get('max_redeem_fraction_bp') as number) ?? 10000,
    },
    baseDeliveryFee:
      (map.get('base_delivery_fee_table') as EngineConfig['baseDeliveryFee']) ?? {
        express: 9900,
        standard: 4900,
        pickup: 0,
        try_and_buy: 9900,
      },
    surgeMultiplier: (map.get('surge_multiplier') as number) ?? 1.0,
    tcsRateBp: (map.get('tcs_rate_bp') as number) ?? 100,
  };
  if (store.deliveryOverridePaise !== null) {
    cfg.deliveryOverridePaise = store.deliveryOverridePaise;
  }
  if (store.handlingFeePaise !== null) {
    cfg.handlingFeePaise = store.handlingFeePaise;
  }
  if (store.convenienceFeePaise !== null) {
    cfg.convenienceFeePaise = store.convenienceFeePaise;
  }
  return cfg;
}
