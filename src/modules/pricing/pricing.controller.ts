/**
 * Pricing surface — the single source of truth for the consumer app. Every price,
 * discount, fee, tax, loyalty figure and total is produced here by the same engine
 * (`computeQuote`) that places orders, so the cart, the checkout steps and the placed
 * order can never disagree. Optional auth: a signed-in token enriches the quote
 * (loyalty/wallet eligibility), a guest gets a clean preview.
 */
import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { computeQuote, type QuoteContext } from '@/shared/orders/compute-quote.js';
import type { PriceCartBody, PriceQuoteBody } from './pricing.validators.js';

type Auth = AccessTokenPayload | undefined;

/** Shared response shape for one priced store-order. */
function shapeQuote(q: QuoteContext) {
  return {
    pricing: q.breakdown,
    lines: q.lines,
    deliveryOptions: q.deliveryOptions,
    rejectedCodes: q.rejectedCodes,
    wallet: {
      balancePaise: q.walletBalancePaise,
      appliedPaise: q.walletAppliedPaise,
      amountDuePaise: q.amountDuePaise,
    },
    stock: q.stock,
  };
}

/** POST /pricing/quote — one store-order (checkout). consumerId from the token if present. */
export async function priceOrder(input: { auth: Auth; body: z.infer<typeof PriceQuoteBody> }) {
  const { auth, body } = input;
  const q = await computeQuote(db, {
    ...(auth?.sub && { consumerId: auth.sub }),
    storeId: body.storeId,
    items: body.items,
    deliveryMethod: body.deliveryMethod,
    paymentMethod: body.paymentMethod,
    ...(body.addressId !== undefined && { addressId: body.addressId }),
    ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
    ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode }),
    ...(body.pointsToRedeem !== undefined && { pointsToRedeem: body.pointsToRedeem }),
    ...(body.applyWallet !== undefined && { applyWallet: body.applyWallet }),
  });
  return ok(shapeQuote(q));
}

// Cart preview prices every store-order at a default method (delivery is re-chosen at
// checkout) so the cart can show a concrete, engine-computed total.
const CART_DEFAULT_METHOD = 'standard' as const;
const CART_DEFAULT_PAYMENT = 'upi' as const;

/** POST /pricing/cart — whole cart, grouped by store, with a backend aggregate. */
export async function priceCart(input: { auth: Auth; body: z.infer<typeof PriceCartBody> }) {
  const { auth, body } = input;

  // Resolve each variant's store and group the cart by store (one order per retailer).
  const variantIds = body.items.map((i) => i.variantId);
  const rows = await db.query.variants.findMany({
    where: inArray(variants.id, variantIds),
    with: { listing: { columns: { storeId: true } } },
  });
  const storeByVariant = new Map(rows.map((v) => [v.id, v.listing.storeId]));

  const grouped = new Map<string, { variantId: string; qty: number }[]>();
  for (const it of body.items) {
    const storeId = storeByVariant.get(it.variantId);
    if (!storeId) throw new AppError(404, ErrorCode.NotFound, `Variant ${it.variantId} not found`);
    const list = grouped.get(storeId);
    if (list) list.push(it);
    else grouped.set(storeId, [it]);
  }

  const stores: Array<{
    storeId: string;
    storeName: string;
    lines: QuoteContext['lines'];
    pricing: QuoteContext['breakdown'];
    deliveryOptions: QuoteContext['deliveryOptions'];
    rejectedCodes: QuoteContext['rejectedCodes'];
  }> = [];
  const agg = {
    itemsSubtotalPaise: 0,
    discountPaise: 0,
    deliveryFeePaise: 0,
    taxPaise: 0,
    grandTotalPaise: 0,
    loyaltyEarnedPoints: 0,
    defaultDeliveryMethod: CART_DEFAULT_METHOD,
  };

  for (const [storeId, items] of grouped) {
    const q = await computeQuote(db, {
      ...(auth?.sub && { consumerId: auth.sub }),
      storeId,
      items,
      deliveryMethod: CART_DEFAULT_METHOD,
      paymentMethod: CART_DEFAULT_PAYMENT,
      ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
      ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode }),
    });
    const b = q.breakdown;
    stores.push({
      storeId,
      storeName: q.store.legalName,
      lines: q.lines,
      pricing: b,
      deliveryOptions: q.deliveryOptions,
      rejectedCodes: q.rejectedCodes,
    });
    agg.itemsSubtotalPaise += b.lineSubtotalPaise;
    agg.discountPaise +=
      b.couponDiscountPaise + b.retailerPromoDiscountPaise + b.platformPromoDiscountPaise + b.loyaltyDiscountPaise;
    agg.deliveryFeePaise += b.deliveryFeePaise;
    agg.taxPaise += b.cgstPaise + b.sgstPaise + b.igstPaise;
    agg.grandTotalPaise += b.totalPaise;
    agg.loyaltyEarnedPoints += b.loyaltyEarnedPoints;
  }

  // Top-level coupon/voucher status: a code is "rejected" only if every store that
  // saw it rejected it (it may apply in one store and not another).
  const attempted = [body.couponCode, body.voucherCode].filter((c): c is string => !!c);
  const rejectedCodes: { code: string; kind: string; reason: string }[] = [];
  for (const code of attempted) {
    const upper = code.toUpperCase();
    const perStore = stores.map((s) => s.rejectedCodes.find((r) => r.code.toUpperCase() === upper));
    if (stores.length > 0 && perStore.every((r) => r)) {
      const first = perStore.find((r) => r)!;
      rejectedCodes.push({ code: first.code, kind: first.kind, reason: first.reason });
    }
  }

  return ok({ stores, aggregate: agg, rejectedCodes });
}
