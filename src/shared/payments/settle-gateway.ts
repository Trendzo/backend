/**
 * Settle a Razorpay checkout against our pending payment row(s). Two callers,
 * both idempotent, either may land first:
 *   - the client's verify-payment call (signature already checked by the route)
 *   - the payment.captured webhook
 *
 * A group checkout shares one gateway_order_id across N child payment rows —
 * settling flips them all and confirms/routes each child order. gatewayRef =
 * the razorpay payment id; group children after the first get a '#n' suffix so
 * settlement recon never flags duplicates (refund calls strip the suffix).
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orders, payments } from '@/db/schema/index.js';
import { transitionOrder } from '@/shared/orders/transition.js';
import { dispatchOrder } from '@/shared/orders/routing.js';

export async function settleGatewayCapture(
  database: typeof Db,
  input: { gatewayOrderId: string; razorpayPaymentId: string },
): Promise<{ settledOrderIds: string[]; alreadySettled: boolean }> {
  const rows = await database.query.payments.findMany({
    where: eq(payments.gatewayOrderId, input.gatewayOrderId),
    orderBy: (p, { asc }) => asc(p.initiatedAt),
  });
  if (rows.length === 0) return { settledOrderIds: [], alreadySettled: false };

  const settledOrderIds: string[] = [];
  let flippedAny = false;
  let n = 0;
  for (const row of rows) {
    const ref = n === 0 ? input.razorpayPaymentId : `${input.razorpayPaymentId}#${n}`;
    n += 1;
    if (row.status === 'pending') {
      const [flipped] = await database
        .update(payments)
        .set({ status: 'succeeded', settledAt: new Date(), gatewayRef: ref })
        .where(and(eq(payments.id, row.id), eq(payments.status, 'pending')))
        .returning({ id: payments.id });
      if (flipped) flippedAny = true;
    }
    // Drive the order forward regardless of who flipped the payment — a verify
    // call racing the webhook must still converge the order.
    const order = await database.query.orders.findFirst({
      where: eq(orders.id, row.orderId),
      columns: { id: true, status: true },
    });
    if (!order) continue;
    if (order.status === 'pending' || order.status === 'payment_failed') {
      if (order.status === 'payment_failed') {
        // Late capture on an attempt the order had already marked failed —
        // bring it back through pending so the audit trail stays legal.
        await transitionOrder(database, {
          orderId: order.id,
          toStatus: 'pending',
          actorType: 'system',
          actorId: 'system',
          reason: 'gateway_capture_recovered',
        }).catch(() => undefined);
      }
      try {
        await transitionOrder(database, {
          orderId: order.id,
          toStatus: 'confirmed',
          actorType: 'system',
          actorId: 'system',
          reason: 'payment_succeeded',
          metadata: { paymentId: row.id, razorpayPaymentId: input.razorpayPaymentId },
        });
        await transitionOrder(database, {
          orderId: order.id,
          toStatus: 'routing',
          actorType: 'system',
          actorId: 'system',
          reason: 'auto_route',
        });
        await dispatchOrder(order.id);
      } catch (err) {
        console.error(
          `[gateway-settle] confirm/route ${order.id}: ${(err as Error).message}`,
        );
      }
    }
    settledOrderIds.push(order.id);
  }
  return { settledOrderIds, alreadySettled: !flippedAny };
}

/**
 * Checkout dismissed / payment failed on the gateway. Fails the still-pending
 * payment row(s) and moves their orders pending → payment_failed so the retry
 * endpoint (or the abandonment sweep) owns them from here. No-ops rows already
 * settled — a capture that raced in wins.
 */
export async function failGatewayCheckout(
  database: typeof Db,
  input: { gatewayOrderId: string; failureCode?: string; failureMessage?: string },
): Promise<{ failedOrderIds: string[] }> {
  const rows = await database.query.payments.findMany({
    where: eq(payments.gatewayOrderId, input.gatewayOrderId),
  });
  const failedOrderIds: string[] = [];
  for (const row of rows) {
    if (row.status !== 'pending') continue;
    const [flipped] = await database
      .update(payments)
      .set({
        status: 'failed',
        settledAt: new Date(),
        failureCode: input.failureCode ?? 'checkout_failed',
        failureMessage: input.failureMessage ?? 'Payment was not completed',
      })
      .where(and(eq(payments.id, row.id), eq(payments.status, 'pending')))
      .returning({ id: payments.id });
    if (!flipped) continue;
    const order = await database.query.orders.findFirst({
      where: eq(orders.id, row.orderId),
      columns: { id: true, status: true },
    });
    if (order?.status === 'pending') {
      await transitionOrder(database, {
        orderId: order.id,
        toStatus: 'payment_failed',
        actorType: 'system',
        actorId: 'system',
        reason: 'gateway_payment_failed',
        metadata: { paymentId: row.id },
      }).catch(() => undefined);
      failedOrderIds.push(order.id);
    }
  }
  return { failedOrderIds };
}
