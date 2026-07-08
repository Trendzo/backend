/**
 * Goods physically arrived back at the store (driver drop-off or retailer
 * confirmation). One funnel for the whole arrival choreography:
 *
 *   1. returning_to_store → returned_to_store (if not already there)
 *   2. auto-accept every pending door_return (try-and-buy refund-on-arrival rule)
 *   3. finalize — returned_to_store → cancelled once nothing is pending and no
 *      dispute is open (finalize also releases leftover reservations + creates
 *      the cancellation refund for the never-refunded remainder).
 *
 * Auto-accept runs as `system` regardless of who confirmed arrival: it is a
 * product rule, not a human decision — and it keeps the driver path legal
 * (returned_to_store→cancelled excludes 'delivery_agent' in the state machine).
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { autoAcceptDoorReturnsOnArrival } from '@/shared/returns/auto-accept-door-returns.js';
import { finalizeReturnedOrder } from './finalize-return.js';
import { transitionOrder } from './transition.js';
import type { ActorType, OrderStatus } from './state-machine.js';

export async function arriveOrderAtStore(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
): Promise<{ orderId: string; status: OrderStatus }> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  let status = order.status as OrderStatus;

  if (status === 'returning_to_store') {
    const r = await transitionOrder(database, {
      orderId,
      toStatus: 'returned_to_store',
      actorType: actor.type,
      actorId: actor.id,
      reason: 'goods_received_at_store',
    });
    status = r.toStatus;
  }

  if (status === 'returned_to_store') {
    await autoAcceptDoorReturnsOnArrival(database, orderId).catch((err) => {
      console.error(`[arrive-at-store] auto-accept ${orderId}: ${(err as Error).message}`);
    });
    await finalizeReturnedOrder(database, orderId, { type: 'system', id: 'system' }).catch(
      (err) => {
        console.error(`[arrive-at-store] finalize ${orderId}: ${(err as Error).message}`);
      },
    );
    const fresh = await database.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { status: true },
    });
    if (fresh) status = fresh.status as OrderStatus;
  }

  return { orderId, status };
}
