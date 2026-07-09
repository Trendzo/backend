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
import { placeOrder } from '@/shared/orders/place-order.js';
import { placeGroupOrder } from '@/shared/orders/place-group-order.js';
import { cancelOrder } from '@/shared/orders/cancel.js';
import { transitionOrder } from '@/shared/orders/transition.js';
import {
  createRazorpayOrder,
  isRazorpayActive,
  razorpayKeyId,
  verifyCheckoutSignature,
} from '@/shared/payments/razorpay.js';
import {
  failGatewayCheckout,
  settleGatewayCapture,
} from '@/shared/payments/settle-gateway.js';
import { payments } from '@/db/schema/index.js';
import type {
  CancelOrderBody,
  PaymentFailedBody,
  PlaceGroupOrderBody,
  PlaceOrderBody,
  VerifyPaymentBody,
} from './checkout.validators.js';

type Auth = AccessTokenPayload;
type PlaceInput = z.infer<typeof PlaceOrderBody>;

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

/**
 * Multi-retailer cart checkout: the server buckets the cart by store and places
 * one child order per store under ONE group — all-or-nothing (any failure
 * unwinds the placed siblings and 409s back to the client for a re-quote).
 */
export async function placeConsumerGroupOrder(input: {
  auth: Auth;
  body: z.infer<typeof PlaceGroupOrderBody>;
}) {
  const { auth, body } = input;
  const idempotencyKey =
    body.idempotencyKey ?? newId(IdPrefix.OrderGroup).replace(/^og_/, 'gik_');
  const result = await placeGroupOrder(db, {
    consumerId: auth.sub,
    items: body.items,
    deliveryMethod: body.deliveryMethod,
    paymentMethod: body.paymentMethod,
    paymentOutcome: body.paymentOutcome,
    ...(body.addressId !== undefined && { addressId: body.addressId }),
    ...(body.applyWallet !== undefined && { applyWallet: body.applyWallet }),
    ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
    ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode }),
    ...(body.pointsToRedeem !== undefined && { pointsToRedeem: body.pointsToRedeem }),
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

/** Assert every payment row on this gateway order belongs to the caller. */
async function assertGatewayOrderOwnership(gatewayOrderId: string, consumerId: string) {
  const rows = await db.query.payments.findMany({
    where: eq(payments.gatewayOrderId, gatewayOrderId),
    with: { order: { columns: { consumerId: true } } },
  });
  if (rows.length === 0) {
    throw new AppError(404, ErrorCode.NotFound, 'Unknown payment reference');
  }
  if (rows.some((r) => r.order.consumerId !== consumerId)) {
    throw new AppError(403, ErrorCode.Forbidden, 'Payment does not belong to you');
  }
}

/**
 * Razorpay Checkout succeeded on the device: verify the HMAC-signed triplet,
 * then settle the pending payment row(s) — flips them succeeded and confirms/
 * routes the order(s). Idempotent; the webhook is the belt-and-braces twin.
 */
export async function verifyPayment(input: { auth: Auth; body: z.infer<typeof VerifyPaymentBody> }) {
  const { body } = input;
  if (!isRazorpayActive()) {
    throw new AppError(503, ErrorCode.InternalError, 'Payment gateway is not configured');
  }
  await assertGatewayOrderOwnership(body.razorpayOrderId, input.auth.sub);
  const okSig = verifyCheckoutSignature({
    razorpayOrderId: body.razorpayOrderId,
    razorpayPaymentId: body.razorpayPaymentId,
    signature: body.razorpaySignature,
  });
  if (!okSig) {
    throw new AppError(400, ErrorCode.ValidationError, 'Payment signature verification failed');
  }
  const r = await settleGatewayCapture(db, {
    gatewayOrderId: body.razorpayOrderId,
    razorpayPaymentId: body.razorpayPaymentId,
  });
  return ok({ verified: true, orderIds: r.settledOrderIds });
}

/** Checkout dismissed / failed on the device — fail the pending attempt so retry owns it. */
export async function reportPaymentFailed(input: {
  auth: Auth;
  body: z.infer<typeof PaymentFailedBody>;
}) {
  await assertGatewayOrderOwnership(input.body.razorpayOrderId, input.auth.sub);
  const r = await failGatewayCheckout(db, {
    gatewayOrderId: input.body.razorpayOrderId,
    failureCode: 'checkout_abandoned',
    ...(input.body.reason ? { failureMessage: input.body.reason } : {}),
  });
  return ok({ failedOrderIds: r.failedOrderIds });
}

/**
 * Retry payment on an order whose gateway attempt failed (or is still pending
 * after an abandoned Checkout). Supersedes the old attempt, mints a fresh
 * Razorpay order, moves payment_failed → pending, returns a new Checkout block.
 */
export async function retryPayment(input: { auth: Auth; id: string }) {
  if (!isRazorpayActive()) {
    throw new AppError(503, ErrorCode.InternalError, 'Payment gateway is not configured');
  }
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, input.id), eq(orders.consumerId, input.auth.sub)),
  });
  if (!order) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
  if (order.status !== 'payment_failed' && order.status !== 'pending') {
    throw new AppError(409, ErrorCode.InvalidState, `Order is ${order.status} — nothing to pay`);
  }
  const succeeded = await db.query.payments.findFirst({
    where: and(eq(payments.orderId, order.id), eq(payments.status, 'succeeded')),
  });
  if (succeeded) {
    throw new AppError(409, ErrorCode.InvalidState, 'Order is already paid');
  }
  const last = await db.query.payments.findFirst({
    where: eq(payments.orderId, order.id),
    orderBy: (p, { desc: d }) => d(p.initiatedAt),
  });
  if (!last) throw new AppError(409, ErrorCode.InvalidState, 'Order has no payment attempt');

  const rzpOrder = await createRazorpayOrder({
    amountPaise: last.amountPaise,
    receipt: order.id,
    notes: { orderId: order.id, retryOf: last.id },
  });
  const newPaymentId = newId(IdPrefix.Payment);
  await db.transaction(async (tx) => {
    if (last.status === 'pending') {
      await tx
        .update(payments)
        .set({ status: 'superseded' })
        .where(and(eq(payments.id, last.id), eq(payments.status, 'pending')));
    }
    await tx.insert(payments).values({
      id: newPaymentId,
      orderId: order.id,
      method: last.method,
      amountPaise: last.amountPaise,
      status: 'pending',
      gatewayOrderId: rzpOrder.id,
      previousPaymentId: last.id,
      idempotencyKey: `${last.idempotencyKey}#r${Date.now().toString(36)}`,
    });
  });
  if (order.status === 'payment_failed') {
    await transitionOrder(db, {
      orderId: order.id,
      toStatus: 'pending',
      actorType: 'consumer',
      actorId: input.auth.sub,
      reason: 'payment_retry',
      metadata: { paymentId: newPaymentId },
    });
  }
  return ok({
    orderId: order.id,
    payment: {
      gateway: 'razorpay' as const,
      keyId: razorpayKeyId(),
      gatewayOrderId: rzpOrder.id,
      amountPaise: last.amountPaise,
      currency: 'INR' as const,
    },
  });
}

/**
 * Retry payment for a whole (multi-store) group: supersedes each child's failed/
 * abandoned attempt, mints ONE fresh Razorpay order across the children, and
 * returns a single Checkout block. Mirror of retryPayment for group checkouts.
 */
export async function retryGroupPayment(input: { auth: Auth; groupId: string }) {
  if (!isRazorpayActive()) {
    throw new AppError(503, ErrorCode.InternalError, 'Payment gateway is not configured');
  }
  const children = await db.query.orders.findMany({
    where: and(eq(orders.groupId, input.groupId), eq(orders.consumerId, input.auth.sub)),
  });
  if (children.length === 0) throw new AppError(404, ErrorCode.NotFound, 'Group not found');
  const payable = children.filter(
    (o) => o.status === 'pending' || o.status === 'payment_failed',
  );
  if (payable.length === 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'Nothing awaiting payment in this group');
  }

  // Latest non-succeeded attempt per payable child.
  const attempts: Array<{ orderId: string; last: typeof payments.$inferSelect }> = [];
  for (const o of payable) {
    const succeeded = await db.query.payments.findFirst({
      where: and(eq(payments.orderId, o.id), eq(payments.status, 'succeeded')),
    });
    if (succeeded) continue;
    const last = await db.query.payments.findFirst({
      where: eq(payments.orderId, o.id),
      orderBy: (p, { desc: d }) => d(p.initiatedAt),
    });
    if (last) attempts.push({ orderId: o.id, last });
  }
  if (attempts.length === 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'Group is already paid');
  }
  const chargePaise = attempts.reduce((s, a) => s + a.last.amountPaise, 0);

  const rzpOrder = await createRazorpayOrder({
    amountPaise: chargePaise,
    receipt: input.groupId,
    notes: { groupId: input.groupId, retry: 'true' },
  });
  const suffix = Date.now().toString(36);
  await db.transaction(async (tx) => {
    for (const a of attempts) {
      if (a.last.status === 'pending') {
        await tx
          .update(payments)
          .set({ status: 'superseded' })
          .where(and(eq(payments.id, a.last.id), eq(payments.status, 'pending')));
      }
      await tx.insert(payments).values({
        id: newId(IdPrefix.Payment),
        orderId: a.orderId,
        method: a.last.method,
        amountPaise: a.last.amountPaise,
        status: 'pending',
        gatewayOrderId: rzpOrder.id,
        previousPaymentId: a.last.id,
        idempotencyKey: `${a.last.idempotencyKey}#r${suffix}`,
      });
    }
  });
  for (const o of payable) {
    if (o.status === 'payment_failed') {
      await transitionOrder(db, {
        orderId: o.id,
        toStatus: 'pending',
        actorType: 'consumer',
        actorId: input.auth.sub,
        reason: 'payment_retry',
      }).catch(() => undefined);
    }
  }
  return ok({
    groupId: input.groupId,
    payment: {
      gateway: 'razorpay' as const,
      keyId: razorpayKeyId(),
      gatewayOrderId: rzpOrder.id,
      amountPaise: chargePaise,
      currency: 'INR' as const,
    },
  });
}

/** One order with line items — ownership enforced via the consumerId filter. */
type OrderRow = typeof orders.$inferSelect;

/** Consumer-safe order-item projection — drops internal tax/promo allocations + hsn/gstRate. */
function shapeOrderItem(it: {
  id: string; listingId: string; variantId: string;
  listingNameSnap: string; brandSnap: string; categorySnap: string;
  galleryImageSnap: string | null; attributesLabelSnap: string; listingPolicySnap: string;
  qty: number; unitPricePaise: number; lineSubtotalPaise: number; netLinePaise: number; outcome: string;
}) {
  return {
    id: it.id,
    listingId: it.listingId,
    variantId: it.variantId,
    listingNameSnap: it.listingNameSnap,
    brandSnap: it.brandSnap,
    categorySnap: it.categorySnap,
    galleryImageSnap: it.galleryImageSnap,
    attributesLabelSnap: it.attributesLabelSnap,
    listingPolicySnap: it.listingPolicySnap,
    qty: it.qty,
    unitPricePaise: it.unitPricePaise,
    lineSubtotalPaise: it.lineSubtotalPaise,
    netLinePaise: it.netLinePaise,
    outcome: it.outcome,
  };
}

/**
 * Consumer-safe order-detail projection. Whitelist (default-deny) so no internal
 * column ever leaks to the app: strips agentHandoffCode, routing internals, fee/TCS
 * snaps, cod cash, idempotencyKey, PII-scrub marker, etc. KEEPS deliveryOtp +
 * pickupCode — those are the consumer's own handover proofs.
 */
function shapeOrderDetail(o: OrderRow & { items: Parameters<typeof shapeOrderItem>[0][] }) {
  return {
    id: o.id,
    groupId: o.groupId,
    storeId: o.storeId,
    addressId: o.addressId,
    deliveryMethod: o.deliveryMethod,
    paymentMethod: o.paymentMethod,
    paymentMethodLabel: o.paymentMethodLabel,
    status: o.status,
    // own PII snapshot
    consumerNameSnap: o.consumerNameSnap,
    consumerEmailSnap: o.consumerEmailSnap,
    consumerPhoneSnap: o.consumerPhoneSnap,
    addressLine1Snap: o.addressLine1Snap,
    addressLine2Snap: o.addressLine2Snap,
    addressCitySnap: o.addressCitySnap,
    addressPincodeSnap: o.addressPincodeSnap,
    addressStateCodeSnap: o.addressStateCodeSnap,
    addressLatSnap: o.addressLatSnap,
    addressLngSnap: o.addressLngSnap,
    // store snapshot
    storeNameSnap: o.storeNameSnap,
    storeAddressSnap: o.storeAddressSnap,
    storeGstinSnap: o.storeGstinSnap,
    storeStateCodeSnap: o.storeStateCodeSnap,
    // pricing snapshot
    itemsSubtotalPaise: o.itemsSubtotalPaise,
    retailerPromoPaise: o.retailerPromoPaise,
    platformPromoPaise: o.platformPromoPaise,
    couponPaise: o.couponPaise,
    pointsRedeemedPaise: o.pointsRedeemedPaise,
    walletAppliedPaise: o.walletAppliedPaise,
    taxPaise: o.taxPaise,
    taxSplitKind: o.taxSplitKind,
    cgstPaise: o.cgstPaise,
    sgstPaise: o.sgstPaise,
    igstPaise: o.igstPaise,
    deliveryFeePaise: o.deliveryFeePaise,
    handlingFeePaise: o.handlingFeePaise,
    convenienceFeePaise: o.convenienceFeePaise,
    grandTotalPaise: o.grandTotalPaise,
    loyaltyEarnedPoints: o.loyaltyEarnedPoints,
    // consumer-facing handover proofs — KEEP
    deliveryOtp: o.deliveryOtp,
    pickupCode: o.pickupCode,
    // pickup slot + try-on window (consumer-facing)
    pickupSlotId: o.pickupSlotId,
    pickupSlotStart: o.pickupSlotStart,
    pickupSlotEnd: o.pickupSlotEnd,
    doorWindowExpiresAt: o.doorWindowExpiresAt,
    // timestamps
    placedAt: o.placedAt,
    acceptedAt: o.acceptedAt,
    packedAt: o.packedAt,
    deliveredAt: o.deliveredAt,
    closedAt: o.closedAt,
    items: o.items.map(shapeOrderItem),
  };
}

export async function getOrder(input: { auth: Auth; id: string }) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, input.id), eq(orders.consumerId, input.auth.sub)),
    with: { items: true },
  });
  if (!order) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
  return ok(shapeOrderDetail(order));
}
