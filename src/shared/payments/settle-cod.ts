/**
 * COD payment truth. COD payments are born `pending` at placement (no cash exists
 * yet) and only become `succeeded` when the cash is physically collected — at the
 * door (driver/retailer/admin deliver) or at the counter (pickup handover). A COD
 * order that dies before collection (cancel / full return) flips its pending
 * payment to `failed` so reconciliation never mistakes it for awaiting-capture.
 *
 * No gateway exists — refs are synthesized (`COD-…` door, `COUNTER-…` pickup),
 * matching the simulated-tender pattern used across the codebase.
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { driverCashLedger, orders, payments } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

/**
 * Mark the order's pending COD payment collected. Idempotent: the conditional
 * `status='pending'` update means a re-delivery / concurrent call no-ops. Also
 * records `orders.codCollectedPaise` — defaulting to the payment's amount (cash
 * actually due: grand total minus the wallet portion), NOT the grand total.
 */
export async function settleCodPaymentOnDelivery(
  database: typeof Db,
  input: { orderId: string; collectedPaise?: number | undefined },
): Promise<{ paymentId: string; gatewayRef: string; codCollectedPaise: number } | null> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    columns: { id: true, paymentMethod: true, deliveryMethod: true, assignedAgentId: true },
  });
  if (!order || order.paymentMethod !== 'cod') return null;

  const pending = await database.query.payments.findFirst({
    where: and(eq(payments.orderId, input.orderId), eq(payments.status, 'pending')),
    orderBy: (p, { desc }) => desc(p.initiatedAt),
  });
  if (!pending) return null; // wallet-fully-covered (born succeeded at 0) or already settled

  const prefix = order.deliveryMethod === 'pickup' ? 'COUNTER' : 'COD';
  const gatewayRef = `${prefix}-${pending.id.slice(4, 16)}`;
  const codCollectedPaise = input.collectedPaise ?? pending.amountPaise;

  return database.transaction(async (tx) => {
    const [flipped] = await tx
      .update(payments)
      .set({ status: 'succeeded', settledAt: new Date(), gatewayRef })
      .where(and(eq(payments.id, pending.id), eq(payments.status, 'pending')))
      .returning({ id: payments.id });
    if (!flipped) return null; // lost a race — someone else settled it
    await tx
      .update(orders)
      .set({ codCollectedPaise })
      .where(eq(orders.id, input.orderId));
    // Cash landed in a DRIVER's hands → append the 'collected' ledger entry
    // (store-handled COD — counter pickup / external courier — has no driver
    // liability, so no entry). Rides the flip guard: exactly-once per order.
    if (order.assignedAgentId && codCollectedPaise > 0) {
      await tx.insert(driverCashLedger).values({
        id: newId(IdPrefix.DriverCashLedger),
        driverId: order.assignedAgentId,
        entryKind: 'collected',
        amountPaise: codCollectedPaise,
        orderId: input.orderId,
      });
    }
    return { paymentId: flipped.id, gatewayRef, codCollectedPaise };
  });
}

/**
 * Fail every still-pending payment on an order that is being cancelled / fully
 * returned. Satisfies the `payments_settled_status_guard` CHECK (failed rows must
 * carry settledAt). `superseded` rows are untouched.
 */
export async function failPendingPaymentsOnCancel(
  database: typeof Db,
  orderId: string,
  failureCode = 'order_cancelled',
): Promise<number> {
  const rows = await database
    .update(payments)
    .set({
      status: 'failed',
      settledAt: new Date(),
      failureCode,
      failureMessage: 'Order cancelled before capture',
    })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')))
    .returning({ id: payments.id });
  return rows.length;
}
