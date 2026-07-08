/**
 * Try-and-buy product rule: the refund initiates AS SOON AS the goods reach back
 * the retailer. The agent already inspected each item at the customer's door, so
 * door returns are auto-accepted (system) the moment the order arrives at the
 * store — the retailer's window to contest is the physical handover itself
 * (declineReturn on the still-pending row BEFORE confirming receipt → dispute).
 *
 * A decline that races this auto-accept WINS: verifyReturn's conditional
 * storeDecision flip yields exactly one winner and the loser's 409 is swallowed
 * here. Standard (post-delivery) returns are untouched — they keep the manual
 * verify + verification-window sweep.
 */
import { eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderItems, orders, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import { verifyReturn } from './verify-return.js';

export async function autoAcceptDoorReturnsOnArrival(
  database: typeof Db,
  orderId: string,
): Promise<{ acceptedReturnIds: string[]; refundIds: string[] }> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, consumerId: true },
  });
  if (!order) return { acceptedReturnIds: [], refundIds: [] };

  const items = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, orderId),
    columns: { id: true },
  });
  const itemIds = items.map((i) => i.id);
  const pendingDoorReturns = itemIds.length
    ? await database.query.returns.findMany({
        where: inArray(returns.orderItemId, itemIds),
        columns: { id: true, kind: true, storeDecision: true },
      })
    : [];

  const acceptedReturnIds: string[] = [];
  const refundIds: string[] = [];
  for (const ret of pendingDoorReturns) {
    if (ret.kind !== 'door_return' || ret.storeDecision !== 'pending') continue;
    try {
      const r = await verifyReturn(database, {
        returnId: ret.id,
        decision: 'accepted',
        reasonNote: 'auto_accepted_on_store_arrival',
        actor: { type: 'system', id: 'system' },
      });
      acceptedReturnIds.push(ret.id);
      if (r.refundId) refundIds.push(r.refundId);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.ReturnAlreadyDecided) continue;
      // Leave the return pending — finalize stays blocked, nothing is lost.
      console.error(
        `[door-return] auto-accept ${ret.id} on ${orderId}: ${(err as Error).message}`,
      );
    }
  }

  if (refundIds.length > 0) {
    await notifyConsumer({
      consumerId: order.consumerId,
      kind: 'refund',
      title: 'Return accepted — refund initiated',
      body:
        refundIds.length === 1
          ? 'Your returned item reached the store; the refund is on its way.'
          : `Your ${refundIds.length} returned items reached the store; refunds are on their way.`,
      deepLink: `/orders/${orderId}`,
      payload: { orderId, refundIds },
    }).catch(() => undefined);
  }

  return { acceptedReturnIds, refundIds };
}
