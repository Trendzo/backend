/**
 * Settle a Razorpay checkout against our pending payment row(s). Two callers, both
 * idempotent, either may land first:
 *   - the client's verify-payment call (signature already checked by the route)
 *   - the payment.captured webhook
 *
 * A group checkout shares one gateway_order_id across N child payment rows — settling
 * flips them all and confirms/routes each child order. gatewayRef = the razorpay
 * payment id; group children after the first get a '#n' suffix so settlement recon
 * never flags duplicates (refund calls strip the suffix).
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: an order is advanced because a payment ROW
 * says succeeded, never because an EVENT arrived. The previous shape drove
 * `payment_failed → pending → confirmed → routing → dispatch` outside the guard that
 * flips the row, so a capture landing after a `payment.failed` recovered and fulfilled
 * the order while its only payment row stayed `failed` — observed live on a real order
 * that was delivered and returned without a captured payment.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orders, payments } from '@/db/schema/index.js';
import { transitionOrder } from '@/shared/orders/transition.js';
import { dispatchOrder } from '@/shared/orders/routing.js';
import { recordOrphanCapture, type OrphanReason } from '@/shared/payments/orphan-capture.js';

export type CaptureRowOutcome =
  | {
      orderId: string;
      paymentId: string;
      payment: 'flipped' | 'recovered_from_failed' | 'already_succeeded';
      advanced: boolean;
    }
  | { orderId: string | null; paymentId: string; payment: 'orphan'; reason: OrphanReason };

export type SettleGatewayResult = {
  /** Orders whose payment is genuinely captured. Excludes orphaned captures. */
  settledOrderIds: string[];
  /** True when nothing flipped on this call — i.e. this was a replay. */
  alreadySettled: boolean;
  results: CaptureRowOutcome[];
  orphans: Extract<CaptureRowOutcome, { payment: 'orphan' }>[];
};

/** Statuses from which a capture may legitimately drive an order forward. */
const AWAITING_PAYMENT = new Set(['pending', 'payment_failed']);

export async function settleGatewayCapture(
  database: typeof Db,
  input: { gatewayOrderId: string; razorpayPaymentId: string },
): Promise<SettleGatewayResult> {
  const rows = await database.query.payments.findMany({
    where: eq(payments.gatewayOrderId, input.gatewayOrderId),
    // Deterministic ordering matters: the '#n' suffix must be stable across replays,
    // or a replay stamps a different gateway_ref and breaks recon.
    orderBy: (p, { asc }) => [asc(p.initiatedAt), asc(p.id)],
  });
  if (rows.length === 0) {
    return { settledOrderIds: [], alreadySettled: false, results: [], orphans: [] };
  }

  const results: CaptureRowOutcome[] = [];
  let flippedAny = false;

  // n increments over EVERY row, including orphaned ones, so the suffix is a stable
  // function of position rather than of how many rows happened to flip.
  let n = 0;
  for (const row of rows) {
    const ref = n === 0 ? input.razorpayPaymentId : `${input.razorpayPaymentId}#${n}`;
    n += 1;

    const outcome = await settleOnePaymentRow(database, {
      row,
      ref,
      gatewayOrderId: input.gatewayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
    });
    results.push(outcome);
    if (outcome.payment === 'flipped' || outcome.payment === 'recovered_from_failed') {
      flippedAny = true;
    }
  }

  const orphans = results.filter(
    (r): r is Extract<CaptureRowOutcome, { payment: 'orphan' }> => r.payment === 'orphan',
  );
  const settledOrderIds = results
    .filter((r) => r.payment !== 'orphan')
    .map((r) => r.orderId as string);

  return { settledOrderIds, alreadySettled: !flippedAny, results, orphans };
}

async function settleOnePaymentRow(
  database: typeof Db,
  args: {
    row: typeof payments.$inferSelect;
    ref: string;
    gatewayOrderId: string;
    razorpayPaymentId: string;
  },
): Promise<CaptureRowOutcome> {
  const { row, ref } = args;

  const decision = await database.transaction(
    async (
      tx,
    ): Promise<
      | { kind: 'paid'; orderId: string; payment: 'flipped' | 'recovered_from_failed' | 'already_succeeded' }
      | { kind: 'orphan'; orderId: string | null; reason: OrphanReason }
    > => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, row.id)).for('update');
      if (!p) return { kind: 'orphan', orderId: null, reason: 'duplicate_capture' };

      const [o] = await tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.id, p.orderId))
        .for('update');
      if (!o) return { kind: 'orphan', orderId: null, reason: 'order_terminal' };

      if (p.status === 'succeeded') {
        // A replay of the same capture is idempotent; a DIFFERENT capture against an
        // already-captured row is real money we did not ask for.
        const base = (p.gatewayRef ?? '').split('#')[0];
        if (base === args.razorpayPaymentId) {
          return { kind: 'paid', orderId: o.id, payment: 'already_succeeded' };
        }
        return { kind: 'orphan', orderId: o.id, reason: 'duplicate_capture' };
      }

      if (p.status === 'superseded') {
        return { kind: 'orphan', orderId: o.id, reason: 'superseded_attempt' };
      }

      // 'pending' or 'failed'. `failed` is NOT terminal for the same gateway order id:
      // Razorpay allows several attempts per order, and our single row models "the
      // charge for this gateway order", not one attempt. A genuine consumer retry mints
      // a NEW gateway order and a NEW row, so recovering here cannot mask one.
      const [otherPaid] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.orderId, p.orderId),
            ne(payments.id, p.id),
            eq(payments.status, 'succeeded'),
          ),
        )
        .limit(1);
      if (otherPaid) return { kind: 'orphan', orderId: o.id, reason: 'already_paid' };

      if (!AWAITING_PAYMENT.has(o.status)) {
        return {
          kind: 'orphan',
          orderId: o.id,
          reason: o.status === 'cancelled' || o.status === 'closed'
            ? 'order_terminal'
            : 'order_not_awaiting_payment',
        };
      }

      const wasFailed = p.status === 'failed';
      const [flipped] = await tx
        .update(payments)
        .set({
          status: 'succeeded',
          settledAt: new Date(),
          gatewayRef: ref,
          failureCode: null,
          failureMessage: null,
        })
        .where(and(eq(payments.id, p.id), eq(payments.status, p.status)))
        .returning({ id: payments.id });
      if (!flipped) return { kind: 'orphan', orderId: o.id, reason: 'duplicate_capture' };

      return {
        kind: 'paid',
        orderId: o.id,
        payment: wasFailed ? 'recovered_from_failed' : 'flipped',
      };
    },
  );

  if (decision.kind === 'orphan') {
    await recordOrphanCapture(database, {
      gatewayOrderId: args.gatewayOrderId,
      gatewayPaymentId: args.razorpayPaymentId,
      paymentId: row.id,
      orderId: decision.orderId,
      amountPaise: row.amountPaise,
      reason: decision.reason,
    }).catch((err) => {
      console.error(`[gateway-settle] orphan record ${row.id}: ${(err as Error).message}`);
    });
    return { orderId: decision.orderId, paymentId: row.id, payment: 'orphan', reason: decision.reason };
  }

  // The payment row is now true, so — and only so — the order may move.
  const advanced = await advanceOrderAfterCapture(database, {
    orderId: decision.orderId,
    paymentId: row.id,
    razorpayPaymentId: args.razorpayPaymentId,
    recoveredFromFailed: decision.payment === 'recovered_from_failed',
  });

  return { orderId: decision.orderId, paymentId: row.id, payment: decision.payment, advanced };
}

/**
 * Drive a paid order to `routing` + dispatch.
 *
 * Idempotent and RESUMABLE: it re-reads the live status before each step and only does
 * what remains, so a throw partway through no longer strands an order half-advanced —
 * the next webhook replay, verify call, or the paid-not-routed sweep finishes it.
 */
export async function advanceOrderAfterCapture(
  database: typeof Db,
  input: {
    orderId: string;
    paymentId?: string;
    razorpayPaymentId?: string;
    recoveredFromFailed?: boolean;
  },
): Promise<boolean> {
  let moved = false;
  try {
    for (let step = 0; step < 4; step += 1) {
      const order = await database.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
        columns: { id: true, status: true, acceptanceDeadlineAt: true },
      });
      if (!order) return moved;

      if (order.status === 'payment_failed') {
        // Bring it back through pending so the audit trail stays legal.
        await transitionOrder(database, {
          orderId: order.id,
          toStatus: 'pending',
          actorType: 'system',
          actorId: 'system',
          reason: 'gateway_capture_recovered',
          metadata: {
            ...(input.paymentId ? { paymentId: input.paymentId } : {}),
            ...(input.razorpayPaymentId ? { razorpayPaymentId: input.razorpayPaymentId } : {}),
            recoveredFrom: 'failed',
          },
        });
        moved = true;
        continue;
      }
      if (order.status === 'pending') {
        await transitionOrder(database, {
          orderId: order.id,
          toStatus: 'confirmed',
          actorType: 'system',
          actorId: 'system',
          reason: 'payment_succeeded',
          metadata: {
            ...(input.paymentId ? { paymentId: input.paymentId } : {}),
            ...(input.razorpayPaymentId ? { razorpayPaymentId: input.razorpayPaymentId } : {}),
          },
        });
        moved = true;
        continue;
      }
      if (order.status === 'confirmed') {
        await transitionOrder(database, {
          orderId: order.id,
          toStatus: 'routing',
          actorType: 'system',
          actorId: 'system',
          reason: 'auto_route',
        });
        moved = true;
        continue;
      }
      if (order.status === 'routing') {
        await dispatchOrder(order.id);
        return true;
      }
      // Anything further along is already past the point this function owns.
      return moved;
    }
  } catch (err) {
    // Leave it for the resumable retry rather than losing the order mid-transition.
    console.error(`[gateway-settle] advance ${input.orderId}: ${(err as Error).message}`);
  }
  return moved;
}

/**
 * Checkout dismissed / payment failed on the gateway. Fails the still-pending payment
 * row(s) and moves their orders pending → payment_failed so the retry endpoint (or the
 * abandonment sweep) owns them from here. No-ops rows already settled — a capture that
 * raced in wins.
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
