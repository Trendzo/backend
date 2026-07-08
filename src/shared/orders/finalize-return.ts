/**
 * Drive a fully-returned order toward a terminal state once the goods are back
 * and every return is resolved:
 *
 *   returning_to_store → returned_to_store   (goods physically received)
 *   returned_to_store  → cancelled           (all returns resolved, nothing kept)
 *
 * Partial returns (some items kept) already went at_door → delivered at door
 * close, so they never reach returning_to_store. Idempotent + best-effort:
 * callers wrap in .catch() so finalization never breaks the primary action.
 */
import { eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { customerIssues, orderItems, orders, returns } from '@/db/schema/index.js';
import { createRefundForCancellation } from '@/shared/refunds/create-cancellation-refund.js';
import { failPendingPaymentsOnCancel } from '@/shared/payments/settle-cod.js';
import type { ActorType, OrderStatus } from '@/shared/orders/state-machine.js';
import { releaseUnfinalizedReservations } from './release-reservations.js';
import { transitionOrder } from './transition.js';

export const OPEN_ISSUE_STATUSES = ['open', 'requested_evidence', 'escalated'] as const;

export async function finalizeReturnedOrder(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
): Promise<void> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true },
  });
  if (!order) return;
  let status = order.status as OrderStatus;

  if (status === 'returning_to_store') {
    await transitionOrder(database, {
      orderId,
      toStatus: 'returned_to_store',
      actorType: actor.type,
      actorId: actor.id,
      reason: 'goods_received_at_store',
    });
    status = 'returned_to_store';
  }

  if (status === 'returned_to_store') {
    const items = await database.query.orderItems.findMany({
      where: eq(orderItems.orderId, orderId),
      columns: { id: true },
    });
    const itemIds = items.map((i) => i.id);
    const rets = itemIds.length
      ? await database.query.returns.findMany({
          where: inArray(returns.orderItemId, itemIds),
          columns: { id: true, storeDecision: true },
        })
      : [];
    const anyPending = rets.some((r) => r.storeDecision === 'pending');

    // Do NOT terminalize while a dispute is open — a declined return waits at
    // returned_to_store with funds held until the admin decides; decideIssue
    // then re-runs this and finalizes. A return-decline dispute links via
    // returnId (its orderId is null), so check both orderId and the return ids.
    const returnIds = rets.map((r) => r.id);
    const openIssues = await database.query.customerIssues.findMany({
      where: inArray(customerIssues.status, [...OPEN_ISSUE_STATUSES]),
      columns: { orderId: true, returnId: true },
    });
    const openDispute = openIssues.some(
      (i) => i.orderId === orderId || (i.returnId && returnIds.includes(i.returnId)),
    );

    if (!anyPending && !openDispute) {
      await transitionOrder(database, {
        orderId,
        toStatus: 'cancelled',
        actorType: actor.type,
        actorId: actor.id,
        reason: 'fully_returned',
      });
      // Items that never finalized (e.g. a fully-undelivered order has no return
      // rows at all) still hold their placement reservation — release it.
      await releaseUnfinalizedReservations(database, orderId).catch((err) => {
        console.error(`[finalize-return] release ${orderId}: ${(err as Error).message}`);
      });
      // Kill any never-collected COD payment, then refund the never-refunded
      // remainder (per-return refunds already covered accepted lines; the
      // paid−refunded base makes this a top-up, never a double refund).
      await failPendingPaymentsOnCancel(database, orderId).catch((err) => {
        console.error(`[finalize-return] fail-pending ${orderId}: ${(err as Error).message}`);
      });
      await createRefundForCancellation(database, {
        orderId,
        reason: 'order_cancelled:fully_returned',
        actor: { type: 'system', id: 'system' },
      }).catch((err) => {
        console.error(`[finalize-return] refund ${orderId}: ${(err as Error).message}`);
      });
    }
  }
}
