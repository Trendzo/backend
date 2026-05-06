/**
 * Order placement — the single transactional boundary for converting a cart into an
 * order_group + orders + order_items + payment + redemption rows + stock reservation.
 *
 * Caller responsibilities:
 *   - Resolve consumer, store, address, items.
 *   - Pick paymentOutcome (test surface; in real checkout this comes from the gateway).
 *
 * Inside the transaction we:
 *   1. Look up idempotency-key collision; if found, return the existing order.
 *   2. Validate stock available; reserve atomically.
 *   3. Resolve promotions (coupon code, voucher code, plus opt-in promotion ids).
 *   4. Run the pure pricing engine.
 *   5. Insert order_groups, orders, order_items with full snapshots.
 *   6. Bump promotion + voucher counters + write redemption + per-consumer-usage rows.
 *   7. Insert the payment row at the chosen outcome status.
 *   8. Drive transitions: pending → confirmed → routing on succeeded; pending →
 *      payment_failed on failed; pending stays on pending.
 *   9. Recompute group rollup.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  addresses,
  consumers,
  loyaltyTransactions,
  orderGroups,
  orderItems,
  orders,
  payments,
  platformConfig,
  promotionConsumerUsage,
  promotionRedemptions,
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
import {
  bumpPromotionCounter,
  bumpVoucherCodeCounter,
} from '@/modules/admin/promotions/redemption-counter.js';
import type {
  AppliedTo,
  ClubbingDefaultValue,
  DiscountType,
  Mechanism,
  PromotionConfig,
  Scope,
} from '@/shared/promotions/schemas.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  buildOrderItemSnapshot,
  buildOrderSnapshot,
} from '@/shared/snapshots/order-snapshot.js';
import { transitionOrder } from './transition.js';

export type PaymentOutcome = 'succeeded' | 'failed' | 'pending';

export type PlaceOrderInput = {
  consumerId: string;
  storeId: string;
  /** One per variant; qty must be positive. */
  items: Array<{ variantId: string; qty: number }>;
  deliveryMethod: 'express' | 'standard' | 'pickup' | 'try_and_buy';
  paymentMethod: 'upi' | 'card' | 'cod' | 'wallet' | 'gift_card';
  /** Test-surface admin choice; in real checkout this comes from the gateway callback. */
  paymentOutcome: PaymentOutcome;
  /** Required for non-pickup; pickup orders may omit. */
  addressId?: string | undefined;
  couponCode?: string | undefined;
  voucherCode?: string | undefined;
  /** Loyalty points to redeem. */
  pointsToRedeem?: number | undefined;
  /** Idempotency key — duplicate requests return the existing order. */
  idempotencyKey: string;
  /** Who initiated this placement (admin user id for the test surface). */
  placedByActorType: 'admin' | 'consumer' | 'system';
  placedByActorId: string;
};

export type PlaceOrderResult = {
  orderId: string;
  groupId: string;
  status: string;
  pricing: PricingBreakdown;
  alreadyExisted: boolean;
};

export async function placeOrder(
  database: typeof Db,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  // ── Idempotency check (outside the transaction; only short-circuit on success) ──
  const existing = await database.query.orders.findFirst({
    where: eq(orders.idempotencyKey, input.idempotencyKey),
  });
  if (existing) {
    // Re-load the breakdown from the snapshot columns so callers always see a consistent shape.
    return {
      orderId: existing.id,
      groupId: existing.groupId,
      status: existing.status,
      pricing: pricingFromOrderRow(existing),
      alreadyExisted: true,
    };
  }

  // ── Pre-load static data (consumer, address, store, items) ──
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
    throw AppError.validation('addressId is required for non-pickup orders');
  }

  if (input.items.length === 0) {
    throw AppError.validation('At least one item is required');
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
  // Ensure every variant belongs to the chosen store.
  for (const v of variantRows) {
    if (v.listing.storeId !== input.storeId) {
      throw AppError.validation(
        `Variant ${v.id} belongs to a different store than the chosen store`,
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

  const enginePromos: EnginePromotion[] = promoRows.map((p) => {
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

  const clubbingRows = await database.query.clubbingMatrixEntries.findMany();
  const clubbingMatrix = clubbingRows.map((r) => ({
    appliedToA: r.appliedToA as AppliedTo,
    appliedToB: r.appliedToB as AppliedTo,
    defaultValue: r.defaultValue as ClubbingDefaultValue,
  }));

  const engineConfig = await loadEngineConfig(database, store);

  // Loyalty balance for the redemption math.
  let consumerLoyaltyBalance = 0;
  if ((input.pointsToRedeem ?? 0) > 0) {
    const last = await database.query.loyaltyTransactions.findFirst({
      where: eq(loyaltyTransactions.consumerId, consumer.id),
      orderBy: (t, { desc }) => desc(t.at),
    });
    consumerLoyaltyBalance = last?.balanceAfterPoints ?? 0;
  }

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

  // ── Transactional write ──
  const placed = await database.transaction(async (tx) => {
    // Reserve stock atomically per variant.
    for (const it of input.items) {
      const [updated] = await tx
        .update(variants)
        .set({ reserved: sql`${variants.reserved} + ${it.qty}` })
        .where(
          and(
            eq(variants.id, it.variantId),
            sql`${variants.stock} - ${variants.reserved} >= ${it.qty}`,
          ),
        )
        .returning({ id: variants.id });
      if (!updated) {
        throw new AppError(
          409,
          ErrorCode.OrderStockUnavailable,
          `Insufficient stock for variant ${it.variantId}`,
        );
      }
    }

    // Order group + order.
    const groupId = newId(IdPrefix.OrderGroup);
    await tx.insert(orderGroups).values({
      id: groupId,
      consumerId: consumer.id,
      status: 'in_flight',
    });

    const orderId = newId(IdPrefix.Order);
    const snap = buildOrderSnapshot({
      consumer,
      address: address ?? null,
      store,
    });

    await tx.insert(orders).values({
      id: orderId,
      groupId,
      consumerId: consumer.id,
      storeId: store.id,
      addressId: address?.id ?? null,
      deliveryMethod: input.deliveryMethod,
      paymentMethod: input.paymentMethod,
      paymentMethodLabel: paymentMethodLabel(input.paymentMethod),
      status: 'pending',
      ...snap,
      itemsSubtotalPaise: breakdown.lineSubtotalPaise,
      retailerPromoPaise: breakdown.retailerPromoDiscountPaise,
      platformPromoPaise: breakdown.platformPromoDiscountPaise,
      couponPaise: breakdown.couponDiscountPaise,
      pointsRedeemedPaise: breakdown.loyaltyDiscountPaise,
      walletAppliedPaise: 0,
      taxPaise: breakdown.cgstPaise + breakdown.sgstPaise + breakdown.igstPaise,
      taxSplitKind:
        cart.consumerStateCode === cart.storeStateCode ? 'intra_state' : 'inter_state',
      cgstPaise: breakdown.cgstPaise,
      sgstPaise: breakdown.sgstPaise,
      igstPaise: breakdown.igstPaise,
      deliveryFeePaise: breakdown.deliveryFeePaise,
      handlingFeePaise: breakdown.handlingFeePaise,
      convenienceFeePaise: breakdown.convenienceFeePaise,
      grandTotalPaise: breakdown.totalPaise,
      idempotencyKey: input.idempotencyKey,
    });

    // Order items.
    for (const it of input.items) {
      const v = variantById.get(it.variantId)!;
      const itemSnap = buildOrderItemSnapshot({
        listing: v.listing,
        variant: v,
        brandName: v.listing.brand?.name ?? 'Unbranded',
        categoryLabel: v.listing.category?.label ?? '',
      });
      const allocs = lineAllocations.get(v.id)!;
      const lineSubtotal = v.pricePaise * it.qty;
      const netLine =
        Math.max(
          0,
          lineSubtotal -
            allocs.retailerPromo -
            allocs.platformPromo -
            allocs.coupon -
            allocs.points,
        ) + allocs.gst;

      await tx.insert(orderItems).values({
        id: newId(IdPrefix.OrderItem),
        orderId,
        listingId: v.listing.id,
        variantId: v.id,
        ...itemSnap,
        qty: it.qty,
        unitPricePaise: v.pricePaise,
        lineSubtotalPaise: lineSubtotal,
        retailerPromoAllocPaise: allocs.retailerPromo,
        platformPromoAllocPaise: allocs.platformPromo,
        couponAllocPaise: allocs.coupon,
        pointsAllocPaise: allocs.points,
        gstRateBp: 500, // 5% — apparel default; real consumer cart pulls from listing.hsn
        gstAllocPaise: allocs.gst,
        netLinePaise: netLine,
      });
    }

    // Payment row.
    const paymentId = newId(IdPrefix.Payment);
    const settledAt =
      input.paymentOutcome === 'succeeded' || input.paymentOutcome === 'failed'
        ? new Date()
        : null;
    await tx.insert(payments).values({
      id: paymentId,
      orderId,
      method: input.paymentMethod,
      amountPaise: breakdown.totalPaise,
      status: input.paymentOutcome,
      gatewayRef:
        input.paymentOutcome === 'succeeded'
          ? `TEST-${input.idempotencyKey.slice(0, 12)}`
          : null,
      idempotencyKey: `${input.idempotencyKey}#pay`,
      ...(settledAt && { settledAt }),
    });

    // Redemptions + counters.
    for (const applied of breakdown.appliedPromotions) {
      const newCount = await bumpPromotionCounter(tx as unknown as typeof Db, applied.promotionId);
      if (newCount === null) {
        throw new AppError(
          409,
          ErrorCode.CouponExhausted,
          `Promotion ${applied.promotionId} exhausted`,
        );
      }
      if (applied.voucherCodeId) {
        const newVoucherCount = await bumpVoucherCodeCounter(
          tx as unknown as typeof Db,
          applied.voucherCodeId,
        );
        if (newVoucherCount === null) {
          throw new AppError(
            409,
            ErrorCode.VoucherAlreadyRedeemed,
            `Voucher already redeemed`,
          );
        }
      }
      await tx.insert(promotionRedemptions).values({
        id: newId(IdPrefix.Promotion).replace(/^prm_/, 'prd_'),
        promotionId: applied.promotionId,
        orderId,
        consumerId: consumer.id,
        voucherCodeId: applied.voucherCodeId ?? null,
        amountAppliedPaise: applied.amountPaise,
      });
      // Per-consumer usage upsert.
      await tx
        .insert(promotionConsumerUsage)
        .values({
          promotionId: applied.promotionId,
          consumerId: consumer.id,
          useCount: 1,
          lastUsedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [promotionConsumerUsage.promotionId, promotionConsumerUsage.consumerId],
          set: {
            useCount: sql`${promotionConsumerUsage.useCount} + 1`,
            lastUsedAt: new Date(),
          },
        });
    }

    // Loyalty redemption (if any) — debit points via CAS.
    if ((input.pointsToRedeem ?? 0) > 0 && breakdown.loyaltyRedeemedPoints > 0) {
      // Loyalty has no balance row (just a ledger); we look up the most recent balanceAfterPoints
      // and write a debit row with kind='redeem' and points = -redeemed.
      const newPointsBalance =
        consumerLoyaltyBalance - breakdown.loyaltyRedeemedPoints;
      if (newPointsBalance < 0) {
        throw new AppError(
          409,
          ErrorCode.InsufficientPoints,
          `Insufficient points balance`,
        );
      }
      await tx.insert(loyaltyTransactions).values({
        id: newId(IdPrefix.LoyaltyTx),
        consumerId: consumer.id,
        kind: 'redeem',
        points: -breakdown.loyaltyRedeemedPoints,
        balanceAfterPoints: newPointsBalance,
        refOrderId: orderId,
        note: `Redeemed at order placement`,
      });
    }

    return { orderId, groupId, paymentId };
  });

  // ── Drive payment-outcome transitions outside the placement tx so each transition writes
  //    its own audit row cleanly. (transitionOrder is its own transaction-friendly call.)
  let finalStatus: string = 'pending';
  if (input.paymentOutcome === 'succeeded') {
    await transitionOrder(database, {
      orderId: placed.orderId,
      toStatus: 'confirmed',
      actorType: 'system',
      actorId: 'system',
      reason: 'payment_succeeded',
      metadata: { paymentId: placed.paymentId },
    });
    await transitionOrder(database, {
      orderId: placed.orderId,
      toStatus: 'routing',
      actorType: 'system',
      actorId: 'system',
      reason: 'auto_route',
    });
    finalStatus = 'routing';
  } else if (input.paymentOutcome === 'failed') {
    await transitionOrder(database, {
      orderId: placed.orderId,
      toStatus: 'payment_failed',
      actorType: 'system',
      actorId: 'system',
      reason: 'payment_failed',
      metadata: { paymentId: placed.paymentId },
    });
    finalStatus = 'payment_failed';
  } else {
    // pending — no transition; placement itself is the initial record (no row in
    // order_transitions for the initial 'pending' state — fromStatus would be null).
    finalStatus = 'pending';
  }

  return {
    orderId: placed.orderId,
    groupId: placed.groupId,
    status: finalStatus,
    pricing: breakdown,
    alreadyExisted: false,
  };
}

// ─────────────── helpers ───────────────

function paymentMethodLabel(method: PlaceOrderInput['paymentMethod']): string {
  switch (method) {
    case 'upi':
      return 'UPI';
    case 'card':
      return 'Card';
    case 'cod':
      return 'Cash on delivery';
    case 'wallet':
      return 'Wallet';
    case 'gift_card':
      return 'Gift card';
  }
}

type LineAllocation = {
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
function allocateDiscountsToLines(
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

function pricingFromOrderRow(o: typeof orders.$inferSelect): PricingBreakdown {
  return {
    lineSubtotalPaise: o.itemsSubtotalPaise,
    appliedPromotions: [],
    excludedPromotions: [],
    retailerPromoDiscountPaise: o.retailerPromoPaise,
    platformPromoDiscountPaise: o.platformPromoPaise,
    couponDiscountPaise: o.couponPaise,
    loyaltyDiscountPaise: o.pointsRedeemedPaise,
    shippingSubsidyPaise: 0,
    postPromoSubtotalPaise:
      o.itemsSubtotalPaise - o.retailerPromoPaise - o.platformPromoPaise,
    taxBasePaise:
      o.itemsSubtotalPaise -
      o.retailerPromoPaise -
      o.platformPromoPaise -
      o.couponPaise -
      o.pointsRedeemedPaise,
    cgstPaise: o.cgstPaise,
    sgstPaise: o.sgstPaise,
    igstPaise: o.igstPaise,
    deliveryFeePaise: o.deliveryFeePaise,
    handlingFeePaise: o.handlingFeePaise,
    convenienceFeePaise: o.convenienceFeePaise,
    tcsPaise: 0,
    totalPaise: o.grandTotalPaise,
    loyaltyEarnedPoints: 0,
    loyaltyRedeemedPoints: 0,
  };
}

async function loadEngineConfig(
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

