/**
 * Consumer checkout. Scoped to the authenticated consumer — consumerId always comes
 * from the access token (auth.sub), never from the request body.
 *
 *   POST /quote      → dry-run pricing + stock + discount/coupon/voucher resolution
 *   POST /           → place an order (reuses the order-core placeOrder)
 *   GET  /orders     → this consumer's order history
 *   GET  /orders/:id → one order (ownership-enforced)
 *
 * The quote and the placement run the SAME computeQuote path, so the quoted total
 * equals the placed total.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { computeQuote } from '@/shared/orders/compute-quote.js';
import { placeOrder } from '@/shared/orders/place-order.js';
import { cancelOrder } from '@/shared/orders/cancel.js';
import type { CancelOrderBody, PlaceOrderBody, QuoteBody } from './checkout.validators.js';

type Auth = AccessTokenPayload;
type QuoteInput = z.infer<typeof QuoteBody>;
type PlaceInput = z.infer<typeof PlaceOrderBody>;

/** Compute a dry-run quote: pricing breakdown + per-variant stock. No writes. */
export async function getQuote(input: { auth: Auth; body: QuoteInput }) {
  const { auth, body } = input;
  const quote = await computeQuote(db, {
    consumerId: auth.sub,
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
  return ok({
    pricing: quote.breakdown,
    stock: quote.stock,
    wallet: {
      balancePaise: quote.walletBalancePaise,
      appliedPaise: quote.walletAppliedPaise,
      amountDuePaise: quote.amountDuePaise,
    },
  });
}

/** Place an order for the authenticated consumer. */
export async function placeConsumerOrder(input: { auth: Auth; body: PlaceInput }) {
  const { auth, body } = input;
  const idempotencyKey =
    body.idempotencyKey ?? newId(IdPrefix.Order).replace(/^ord_/, 'ik_');
  const result = await placeOrder(db, {
    consumerId: auth.sub,
    storeId: body.storeId,
    items: body.items,
    deliveryMethod: body.deliveryMethod,
    paymentMethod: body.paymentMethod,
    paymentOutcome: body.paymentOutcome,
    ...(body.addressId !== undefined && { addressId: body.addressId }),
    ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
    ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode }),
    ...(body.pointsToRedeem !== undefined && { pointsToRedeem: body.pointsToRedeem }),
    ...(body.applyWallet !== undefined && { applyWallet: body.applyWallet }),
    ...(body.pickupSlotId !== undefined && { pickupSlotId: body.pickupSlotId }),
    ...(body.pickupSlotStart !== undefined && { pickupSlotStart: body.pickupSlotStart }),
    ...(body.pickupSlotEnd !== undefined && { pickupSlotEnd: body.pickupSlotEnd }),
    idempotencyKey,
    placedByActorType: 'consumer',
    placedByActorId: auth.sub,
  });
  return ok(result);
}

function orderListRow(o: typeof orders.$inferSelect) {
  return {
    id: o.id,
    groupId: o.groupId,
    storeId: o.storeId,
    storeName: o.storeNameSnap,
    status: o.status,
    deliveryMethod: o.deliveryMethod,
    paymentMethod: o.paymentMethod,
    paymentMethodLabel: o.paymentMethodLabel,
    grandTotalPaise: o.grandTotalPaise,
    placedAt: o.placedAt,
    deliveredAt: o.deliveredAt,
  };
}

/** This consumer's orders, newest first. */
export async function listOrders(input: { auth: Auth }) {
  const rows = await db.query.orders.findMany({
    where: eq(orders.consumerId, input.auth.sub),
    orderBy: [desc(orders.placedAt)],
  });
  return ok(rows.map(orderListRow));
}

/**
 * Consumer-initiated cancellation. Ownership enforced here; the state machine
 * decides whether 'consumer' may cancel from the order's current status
 * (pending/payment_failed/confirmed/accepted — not after packing).
 */
export async function cancelConsumerOrder(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof CancelOrderBody>;
}) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, input.id), eq(orders.consumerId, input.auth.sub)),
    columns: { id: true },
  });
  if (!order) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
  const result = await cancelOrder(db, {
    orderId: input.id,
    actorType: 'consumer',
    actorId: input.auth.sub,
    reason: input.body.reason ?? 'Cancelled by customer',
  });
  return ok(result);
}

/** One order with line items — ownership enforced via the consumerId filter. */
export async function getOrder(input: { auth: Auth; id: string }) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, input.id), eq(orders.consumerId, input.auth.sub)),
    with: { items: true },
  });
  if (!order) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
  return ok(order);
}
