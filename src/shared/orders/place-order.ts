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
  consumerWallets,
  orderGroups,
  orderItems,
  orders,
  payments,
  promotionConsumerUsage,
  promotionRedemptions,
  promotions,
  variants,
  walletTransactions,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { resolveGstRateBp } from '@/shared/pos/gst-rates.js';
import type { PricingBreakdown } from '@/shared/discounts/types.js';
import {
  bumpPromotionCounter,
  bumpVoucherCodeCounter,
} from '@/modules/admin/promotions/redemption-counter.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  buildOrderItemSnapshot,
  buildOrderSnapshot,
} from '@/shared/snapshots/order-snapshot.js';
import { applyLoyaltyDelta } from '@/shared/loyalty/apply-delta.js';
import { ensureWallet } from '@/shared/wallet/ensure-wallet.js';
import { computeQuote, resolveWalletApplyPaise } from './compute-quote.js';
import { generateDeliveryOtp, generatePickupCode } from './pickup-code.js';
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
  /** Apply wallet balance as a partial tender alongside `paymentMethod`. Wallet-only
   *  (`paymentMethod === 'wallet'`) always applies and must fully cover the total. */
  applyWallet?: boolean | undefined;
  /** Idempotency key — duplicate requests return the existing order. */
  idempotencyKey: string;
  /** Who initiated this placement (admin user id for the test surface). */
  placedByActorType: 'admin' | 'consumer' | 'system';
  placedByActorId: string;
  /** §9 — pickup slot snap. Required when deliveryMethod==='pickup' and the caller
   *  is a consumer (real checkout). Admin test placement may omit (auto-default).
   *  All three are stored on the order so slot config edits don't drift. */
  pickupSlotId?: string;
  pickupSlotStart?: Date;
  pickupSlotEnd?: Date;
};

export type PlaceOrderResult = {
  orderId: string;
  groupId: string;
  status: string;
  pricing: PricingBreakdown;
  /** Amount debited from the wallet (0 if wallet not used). */
  walletAppliedPaise: number;
  /** Amount charged to the gateway tender = grandTotal − walletApplied. */
  amountChargedPaise: number;
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
      walletAppliedPaise: existing.walletAppliedPaise,
      amountChargedPaise: existing.grandTotalPaise - existing.walletAppliedPaise,
      alreadyExisted: true,
    };
  }

  // ── Resolve + price everything (read-only, shared with the /checkout/quote path) ──
  // computeQuote performs all the same loads, promotion gating (G1/G2/G4 + store
  // gating) and pricing the consumer quote endpoint uses, so the placed total always
  // matches the quoted total. It does NOT reserve stock — that happens atomically
  // inside the transaction below.
  const quote = await computeQuote(database, {
    consumerId: input.consumerId,
    storeId: input.storeId,
    items: input.items,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    ...(input.addressId !== undefined && { addressId: input.addressId }),
    ...(input.couponCode !== undefined && { couponCode: input.couponCode }),
    ...(input.voucherCode !== undefined && { voucherCode: input.voucherCode }),
    ...(input.pointsToRedeem !== undefined && { pointsToRedeem: input.pointsToRedeem }),
    ...(input.applyWallet !== undefined && { applyWallet: input.applyWallet }),
  });
  const {
    store,
    address,
    variantById,
    cart,
    enginePromos,
    engineConfig,
    breakdown,
    lineAllocations,
  } = quote;

  // Placement always passes a real consumerId, so computeQuote returns a consumer here
  // (the nullable type only covers the guest/preview quote path). Assert it so the
  // value reads as non-null inside the transaction closure below.
  if (!quote.consumer) {
    throw new AppError(401, ErrorCode.Unauthorized, 'A consumer is required to place an order');
  }
  const consumer = quote.consumer;

  // Phone-OTP signups start with only a verified phone; order snapshots freeze
  // consumer name + email as NOT NULL columns, so both must exist before placement.
  const { name: consumerName, email: consumerEmail } = consumer;
  if (!consumerName || !consumerEmail) {
    throw new AppError(
      409,
      ErrorCode.ProfileIncomplete,
      'Add your name and email to your profile before placing an order',
    );
  }
  const snapshotConsumer = { name: consumerName, email: consumerEmail, phone: consumer.phone };

  // ── Transactional write ──
  // The pre-tx idempotency check above is advisory; two requests with the same key can both
  // pass it and race into the transaction. The unique index on orders.idempotency_key lets at
  // most one commit — the loser hits 23505 here. Rather than surface a raw DB error, we replay
  // the winning order, so placement is truly idempotent under concurrency.
  type PlacementTxResult = {
    orderId: string;
    groupId: string;
    paymentId: string;
    walletAppliedPaise: number;
    amountChargedPaise: number;
    effectiveOutcome: PaymentOutcome;
    /** COD remainder pending capture — the order still confirms and routes. */
    codPendingCapture: boolean;
  };
  let placed: PlacementTxResult;
  try {
    placed = await runPlacementTx();
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '23505') {
      const winner = await database.query.orders.findFirst({
        where: eq(orders.idempotencyKey, input.idempotencyKey),
      });
      // A row under this exact (unique) key means a concurrent placement won — replay it.
      if (winner) {
        return {
          orderId: winner.id,
          groupId: winner.groupId,
          status: winner.status,
          pricing: pricingFromOrderRow(winner),
          walletAppliedPaise: winner.walletAppliedPaise,
          amountChargedPaise: winner.grandTotalPaise - winner.walletAppliedPaise,
          alreadyExisted: true,
        };
      }
    }
    throw err;
  }

  async function runPlacementTx(): Promise<PlacementTxResult> {
   return database.transaction(async (tx) => {
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

    // ── TOCTOU guards ──
    // computeQuote ran before this transaction opened, so the breakdown (prices, applied
    // promotions) is a snapshot. Re-read those inputs inside the tx and reject if they drifted,
    // so a committed order can never bake in a stale price or an expired promotion. The client
    // re-quotes on the 409.
    const variantIds = input.items.map((it) => it.variantId);
    const liveVariants = await tx.query.variants.findMany({
      where: inArray(variants.id, variantIds),
      columns: { id: true, pricePaise: true },
    });
    const livePriceById = new Map(liveVariants.map((v) => [v.id, v.pricePaise]));
    for (const it of input.items) {
      const quotedPrice = variantById.get(it.variantId)?.pricePaise;
      const livePrice = livePriceById.get(it.variantId);
      if (livePrice === undefined || livePrice !== quotedPrice) {
        throw new AppError(
          409,
          ErrorCode.OrderPriceChanged,
          `Price for variant ${it.variantId} changed since the quote; please review and retry`,
        );
      }
    }

    if (enginePromos.length > 0) {
      const now = new Date();
      const livePromos = await tx.query.promotions.findMany({
        where: inArray(promotions.id, enginePromos.map((p) => p.id)),
        columns: { id: true, name: true, status: true, validFrom: true, validUntil: true },
      });
      const livePromoById = new Map(livePromos.map((p) => [p.id, p]));
      for (const p of enginePromos) {
        const live = livePromoById.get(p.id);
        if (!live || live.status !== 'active' || live.validFrom > now || live.validUntil < now) {
          throw new AppError(
            409,
            ErrorCode.CouponInvalid,
            `Promotion ${live?.name ?? p.id} is no longer valid; please re-quote`,
          );
        }
      }
    }

    // ── Wallet tender debit (partial or full) ──
    // Balance update only here; the ledger row is written after the order row
    // exists (walletTransactions.refOrderId FKs orders.id). The version CAS +
    // the unique (walletId, walletVersionAfter) index serialize concurrent debits.
    let walletAppliedPaise = 0;
    let walletLedger:
      | { walletId: string; balanceAfterPaise: number; versionAfter: number }
      | null = null;
    const wantsWallet = input.applyWallet === true || input.paymentMethod === 'wallet';
    if (wantsWallet) {
      const walletId = await ensureWallet(tx, consumer.id);
      let settled = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const wallet = await tx.query.consumerWallets.findFirst({
          where: eq(consumerWallets.id, walletId),
        });
        if (!wallet) throw new AppError(500, ErrorCode.InternalError, 'Wallet vanished');
        const applied = resolveWalletApplyPaise({
          paymentMethod: input.paymentMethod,
          applyWallet: input.applyWallet,
          balancePaise: wallet.balancePaise,
          totalPaise: breakdown.totalPaise,
        });
        // Wallet-only must fully cover the order; partial-apply tolerates a shortfall
        // (the remainder is charged to the gateway tender).
        if (input.paymentMethod === 'wallet' && applied < breakdown.totalPaise) {
          throw new AppError(
            409,
            ErrorCode.InsufficientWalletBalance,
            'Insufficient wallet balance to cover the order',
          );
        }
        if (applied === 0) {
          settled = true;
          break;
        }
        const newBalance = wallet.balancePaise - applied;
        const newVersion = wallet.version + 1;
        const [updated] = await tx
          .update(consumerWallets)
          .set({ balancePaise: newBalance, version: newVersion, updatedAt: new Date() })
          .where(and(eq(consumerWallets.id, walletId), eq(consumerWallets.version, wallet.version)))
          .returning();
        if (updated) {
          walletAppliedPaise = applied;
          walletLedger = { walletId, balanceAfterPaise: newBalance, versionAfter: newVersion };
          settled = true;
          break;
        }
      }
      if (!settled) {
        throw new AppError(503, ErrorCode.InternalError, 'Wallet CAS retries exhausted');
      }
    }

    // Order group + order.
    const groupId = newId(IdPrefix.OrderGroup);
    await tx.insert(orderGroups).values({
      id: groupId,
      consumerId: consumer.id,
      status: 'in_flight',
      // Today this is single-store (one order per group). When multi-store split lands,
      // swap this for the sum of per-store breakdown totals.
      combinedTotalPaise: breakdown.totalPaise,
    });

    const orderId = newId(IdPrefix.Order);
    const snap = buildOrderSnapshot({
      consumer: snapshotConsumer,
      address: address ?? null,
      store,
    });

    // Pickup orders carry a short handover code consumers read aloud at the store front.
    // Retry once on the (extremely rare) unique-violation against an active order.
    let pickupCode: string | null = null;
    if (input.deliveryMethod === 'pickup') {
      pickupCode = generatePickupCode();
    }
    // Door deliveries carry a numeric OTP the consumer reads to the agent at handover.
    const deliveryOtp = input.deliveryMethod === 'pickup' ? null : generateDeliveryOtp();

    // §9 — refuse real consumer pickup orders without a slot snap. Admin test
    // placement falls through with NULLs (slot can be backfilled by the admin
    // form's auto-default before insert when needed).
    if (
      input.deliveryMethod === 'pickup'
      && input.placedByActorType === 'consumer'
      && (!input.pickupSlotId || !input.pickupSlotStart || !input.pickupSlotEnd)
    ) {
      throw new AppError(
        400,
        ErrorCode.ValidationError,
        'Pickup orders require pickupSlotId + pickupSlotStart + pickupSlotEnd',
      );
    }

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
      tcsRateBpSnap: engineConfig.tcsRateBp,
      pickupCode,
      deliveryOtp,
      pickupSlotId: input.pickupSlotId ?? null,
      pickupSlotStart: input.pickupSlotStart ?? null,
      pickupSlotEnd: input.pickupSlotEnd ?? null,
      itemsSubtotalPaise: breakdown.lineSubtotalPaise,
      retailerPromoPaise: breakdown.retailerPromoDiscountPaise,
      platformPromoPaise: breakdown.platformPromoDiscountPaise,
      couponPaise: breakdown.couponDiscountPaise,
      pointsRedeemedPaise: breakdown.loyaltyDiscountPaise,
      walletAppliedPaise,
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

    // Wallet ledger row — written now that the order row exists (refOrderId FK).
    if (walletLedger) {
      await tx.insert(walletTransactions).values({
        id: newId(IdPrefix.WalletTx),
        walletId: walletLedger.walletId,
        kind: 'debit',
        amountPaise: -walletAppliedPaise,
        balanceAfterPaise: walletLedger.balanceAfterPaise,
        walletVersionAfter: walletLedger.versionAfter,
        refOrderId: orderId,
        note: 'Debit at order placement',
      });
    }

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
        // Authoritative GST table (same as POS) — must match the rate compute-quote priced with.
        gstRateBp: resolveGstRateBp({
          hsn: v.listing.hsn,
          categorySlug: v.listing.category?.slug ?? null,
          unitMrpPaise: v.pricePaise,
        }),
        gstAllocPaise: allocs.gst,
        netLinePaise: netLine,
      });
    }

    // Payment row. Wallet already collected its portion; the gateway only charges
    // the remainder. When wallet fully covers the order the remainder is 0 and the
    // payment is settled as succeeded regardless of the requested outcome.
    // COD truth: no cash exists at placement, so a COD remainder is ALWAYS born
    // 'pending' (client-passed outcome ignored) and flipped to succeeded by
    // settleCodPaymentOnDelivery when the cash is collected at door/counter.
    const amountChargedPaise = breakdown.totalPaise - walletAppliedPaise;
    const isCodCharge = input.paymentMethod === 'cod' && amountChargedPaise > 0;
    const effectiveOutcome: PaymentOutcome =
      amountChargedPaise === 0 ? 'succeeded' : isCodCharge ? 'pending' : input.paymentOutcome;
    const paymentId = newId(IdPrefix.Payment);
    const settledAt =
      effectiveOutcome === 'succeeded' || effectiveOutcome === 'failed'
        ? new Date()
        : null;
    await tx.insert(payments).values({
      id: paymentId,
      orderId,
      method: input.paymentMethod,
      amountPaise: amountChargedPaise,
      status: effectiveOutcome,
      gatewayRef:
        effectiveOutcome === 'succeeded'
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

    // Loyalty redemption (if any) — debit points via the CAS-guarded balance row.
    // applyLoyaltyDelta re-reads the authoritative balance inside this transaction and throws
    // InsufficientPoints if a concurrent redeem already drew it down, so a stale quote can
    // never overdraw points.
    if (breakdown.loyaltyRedeemedPoints > 0) {
      await applyLoyaltyDelta(tx, {
        consumerId: consumer.id,
        points: -breakdown.loyaltyRedeemedPoints,
        kind: 'redeem',
        refOrderId: orderId,
        note: 'Redeemed at order placement',
      });
    }

    return {
      orderId,
      groupId,
      paymentId,
      walletAppliedPaise,
      amountChargedPaise,
      effectiveOutcome,
      codPendingCapture: isCodCharge,
    };
   });
  }

  // ── Drive payment-outcome transitions outside the placement tx so each transition writes
  //    its own audit row cleanly. (transitionOrder is its own transaction-friendly call.)
  //    COD: the payment row stays 'pending' until cash is collected, but the ORDER still
  //    confirms and routes — order confirmation is decoupled from capture for COD.
  let finalStatus: string = 'pending';
  if (placed.effectiveOutcome === 'succeeded' || placed.codPendingCapture) {
    await transitionOrder(database, {
      orderId: placed.orderId,
      toStatus: 'confirmed',
      actorType: 'system',
      actorId: 'system',
      reason: placed.codPendingCapture ? 'cod_confirmed' : 'payment_succeeded',
      metadata: { paymentId: placed.paymentId },
    });
    await transitionOrder(database, {
      orderId: placed.orderId,
      toStatus: 'routing',
      actorType: 'system',
      actorId: 'system',
      reason: 'auto_route',
    });
    const { dispatchOrder } = await import('./routing.js');
    await dispatchOrder(placed.orderId);
    finalStatus = 'routing';
  } else if (placed.effectiveOutcome === 'failed') {
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
    walletAppliedPaise: placed.walletAppliedPaise,
    amountChargedPaise: placed.amountChargedPaise,
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

