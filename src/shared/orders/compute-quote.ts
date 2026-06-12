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
  consumerId: string;
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
  // ── Pre-load static data (consumer, store, address, items) ──
  const consumer = await database.query.consumers.findFirst({
    where: eq(consumers.id, input.consumerId),
  });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');

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
  } else if (input.deliveryMethod !== 'pickup') {
    // Fall back to the consumer's default address when caller omits addressId.
    address = await database.query.addresses.findFirst({
      where: and(eq(addresses.consumerId, consumer.id), eq(addresses.isDefault, true)),
    });
    if (!address) {
      throw AppError.validation(
        'addressId is required for non-pickup orders and no default address is set',
      );
    }
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
      gstRatePct: 5, // apparel default; real consumer cart picks per HSN
    };
    if (v.listing.brandId) line.brandId = v.listing.brandId;
    if (v.listing.categoryId) line.categoryId = v.listing.categoryId;
    return line;
  });

  const cart: Cart = {
    consumerId: consumer.id,
    consumerStateCode: address?.stateCode ?? store.stateCode,
    storeStateCode: store.stateCode,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    lines: cartLines,
  };

  // ── Resolve promotions ──
  const promoIds = new Set<string>();
  let voucherCodeId: string | undefined;
  let voucherCodePromotionId: string | undefined;

  if (input.couponCode) {
    const promo = await database.query.promotions.findFirst({
      where: and(eq(promotions.name, input.couponCode), eq(promotions.mechanism, 'coupon')),
    });
    if (!promo) {
      throw new AppError(404, ErrorCode.CouponInvalid, `No coupon "${input.couponCode}" found`);
    }
    promoIds.add(promo.id);
  }

  if (input.voucherCode) {
    const code = await database.query.voucherCodes.findFirst({
      where: eq(voucherCodes.code, input.voucherCode.toUpperCase()),
    });
    if (!code) {
      throw new AppError(404, ErrorCode.CouponInvalid, 'Voucher code not found');
    }
    if (code.totalUses != null && code.redeemedCount >= code.totalUses) {
      throw new AppError(409, ErrorCode.VoucherAlreadyRedeemed, 'Voucher already redeemed');
    }
    // §13 P6 — targeted vouchers are reserved for a specific consumer.
    if (code.assignedConsumerId && code.assignedConsumerId !== consumer.id) {
      throw new AppError(
        409,
        ErrorCode.CouponInvalid,
        'Voucher is reserved for a different consumer',
      );
    }
    promoIds.add(code.promotionId);
    voucherCodeId = code.id;
    voucherCodePromotionId = code.promotionId;
  }

  const promoRows =
    promoIds.size === 0
      ? []
      : await database.query.promotions.findMany({
          where: inArray(promotions.id, [...promoIds]),
        });

  // G1: Validate status and validity window before applying any promotion.
  const now = new Date();
  const validPromoRows = promoRows.filter((p) => {
    const isActive = p.status === 'active';
    const inWindow = p.validFrom <= now && p.validUntil >= now;
    if (!isActive || !inWindow) {
      const wasExplicit =
        (input.couponCode && p.mechanism === 'coupon') ||
        (input.voucherCode && p.mechanism === 'voucher');
      if (wasExplicit) {
        throw new AppError(
          409,
          ErrorCode.CouponInvalid,
          `Promotion "${p.name}" is ${!isActive ? p.status : 'outside its validity window'}`,
        );
      }
      return false; // silently drop auto-applied offers that are no longer active
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

  // Loyalty balance — always fetched (used for redemption math and loyaltyTierFilter checks).
  // Read the authoritative consumer_loyalty balance row (the ledger's projection).
  const loyaltyAcct = await database.query.consumerLoyalty.findFirst({
    where: eq(consumerLoyalty.consumerId, consumer.id),
  });
  const consumerLoyaltyBalance = loyaltyAcct?.balancePoints ?? 0;

  // G2: Enforce firstOrderOnly — the engine can't do this DB lookup itself.
  if (enginePromos.some((p) => p.scope?.firstOrderOnly)) {
    const priorOrder = await database.query.orders.findFirst({
      where: and(eq(orders.consumerId, consumer.id), sql`${orders.status} != 'payment_failed'`),
      columns: { id: true },
    });
    if (priorOrder) {
      for (let i = enginePromos.length - 1; i >= 0; i--) {
        if (!enginePromos[i]!.scope?.firstOrderOnly) continue;
        const isExplicit =
          (input.couponCode && enginePromos[i]!.mechanism === 'coupon') ||
          (input.voucherCode && enginePromos[i]!.mechanism === 'voucher');
        if (isExplicit) {
          throw new AppError(409, ErrorCode.CouponInvalid, 'This offer is for first-time orders only');
        }
        enginePromos.splice(i, 1);
      }
    }
  }

  // G4: Enforce loyaltyTierFilter — derive consumer tier from balance vs. platform thresholds.
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
        enginePromos.splice(i, 1);
      }
    }
  }

  // §13 A5 — scope.storeIds gating. The pricing engine's eligibility filter is
  // per-line and ignores storeIds (the cart already represents one store), so we
  // drop here. Explicit coupons/vouchers throw — auto-applied offers silently drop.
  for (let i = enginePromos.length - 1; i >= 0; i--) {
    const storeIds = enginePromos[i]!.scope?.storeIds;
    if (storeIds?.length && !storeIds.includes(store.id)) {
      const promo = enginePromos[i]!;
      const isExplicit =
        (input.couponCode && promo.mechanism === 'coupon') ||
        (input.voucherCode && promo.mechanism === 'voucher');
      if (isExplicit) {
        throw new AppError(
          409,
          ErrorCode.CouponInvalid,
          'This promotion is not available for this store',
        );
      }
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
    pointsToRedeem: input.pointsToRedeem ?? 0,
    consumerLoyaltyBalance,
  });

  // ── Per-item allocations (proportional to line subtotal) ──
  const lineAllocations = allocateDiscountsToLines(cartLines, breakdown);

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
  const walletRow = await database.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, consumer.id),
  });
  const walletBalancePaise = walletRow?.balancePaise ?? 0;
  const walletAppliedPaise = resolveWalletApplyPaise({
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
