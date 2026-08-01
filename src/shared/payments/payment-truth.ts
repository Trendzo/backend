/**
 * "Was this order actually paid for?" — one definition.
 *
 * The sum lived inline in the consumer order shaper and nowhere else, so the order
 * state machine had no way to ask the question. That is how a capture arriving after a
 * `payment.failed` event could route and fulfil an order whose only payment row still
 * said `failed`: the advance was driven by the webhook EVENT, never by a settled ROW.
 */
import { and, eq } from 'drizzle-orm';
import { orders, payments } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type { DbOrTx } from '@/shared/refunds/rollup.js';

/** Wallet money applied at placement + every succeeded payment. */
export async function orderPaidPaise(dbx: DbOrTx, orderId: string): Promise<number> {
  const order = await dbx.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { walletAppliedPaise: true },
  });
  if (!order) return 0;
  const succeeded = await dbx.query.payments.findMany({
    where: and(eq(payments.orderId, orderId), eq(payments.status, 'succeeded')),
    columns: { amountPaise: true },
  });
  return order.walletAppliedPaise + succeeded.reduce((s, p) => s + p.amountPaise, 0);
}

/**
 * Refuse to confirm an order that no captured payment covers.
 *
 * Called from `transitionOrder` on the `→ confirmed` edge, which is the single funnel
 * every order status mutation passes through. COD is exempt: its capture is legitimately
 * deferred to the doorstep, so a pending COD payment row is the expected state.
 *
 * Deliberately not a DB constraint — the invariant spans `orders × payments`, which no
 * CHECK can express, and the repo has no triggers.
 */
export async function assertCapturedBeforeConfirm(dbx: DbOrTx, orderId: string): Promise<void> {
  const order = await dbx.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { grandTotalPaise: true, paymentMethod: true, walletAppliedPaise: true },
  });
  if (!order) return;

  if (order.paymentMethod === 'cod') {
    const codRow = await dbx.query.payments.findFirst({
      where: eq(payments.orderId, orderId),
      columns: { id: true },
    });
    if (codRow) return;
  }

  const paid = await orderPaidPaise(dbx, orderId);
  if (paid >= order.grandTotalPaise) return;

  throw new AppError(
    409,
    ErrorCode.PaymentFailed,
    'Order cannot be confirmed: no captured payment covers the total',
  );
}
