/**
 * Pricing surface — the single source of truth for the consumer app. Every price,
 * discount, fee, tax, loyalty figure and total is produced here by the same engine
 * (`computeQuote`) that places orders, so the cart, the checkout steps and the placed
 * order can never disagree. Optional auth: a signed-in token enriches the quote
 * (loyalty/wallet eligibility), a guest gets a clean preview.
 */
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { computeQuote, type QuoteContext } from '@/shared/orders/compute-quote.js';
import { computeCartQuote } from '@/shared/orders/compute-cart-quote.js';
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

/**
 * POST /pricing/cart — whole cart, grouped by store, with a backend aggregate.
 * A coupon/voucher + redeemed points apply ONCE across the WHOLE cart and are split
 * across the per-store buckets (via `computeCartQuote`), so the cart preview equals
 * what the group checkout will actually place.
 */
export async function priceCart(input: { auth: Auth; body: z.infer<typeof PriceCartBody> }) {
  const { auth, body } = input;
  const cq = await computeCartQuote(db, {
    ...(auth?.sub && { consumerId: auth.sub }),
    items: body.items,
    deliveryMethod: CART_DEFAULT_METHOD,
    paymentMethod: CART_DEFAULT_PAYMENT,
    ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
    ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode }),
    ...(body.pointsToRedeem !== undefined && { pointsToRedeem: body.pointsToRedeem }),
    ...(body.applyWallet !== undefined && { applyWallet: body.applyWallet }),
  });

  const stores = cq.buckets.map((b) => ({
    storeId: b.storeId,
    storeName: b.quote.store.legalName,
    lines: b.quote.lines as QuoteContext['lines'],
    pricing: b.quote.breakdown as QuoteContext['breakdown'],
    deliveryOptions: b.quote.deliveryOptions as QuoteContext['deliveryOptions'],
    rejectedCodes: b.quote.rejectedCodes as QuoteContext['rejectedCodes'],
  }));

  return ok({
    stores,
    aggregate: { ...cq.aggregate, defaultDeliveryMethod: CART_DEFAULT_METHOD },
    rejectedCodes: cq.rejectedCodes.map((r) => ({ code: r.code, kind: r.kind, reason: r.reason })),
  });
}
