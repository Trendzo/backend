/**
 * Cancellation orchestrator. Validates the actor + state via the state machine, releases
 * any reserved stock, and logs a cancellation transition. Refunds for prepaid orders are
 * a stub for this iteration — the refund module ships in its own phase.
 */
import { eq, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderItems, orders, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { transitionOrder } from './transition.js';
import { isTerminal, type ActorType, type OrderStatus } from './state-machine.js';

export type CancelOrderInput = {
  orderId: string;
  actorType: ActorType;
  actorId: string;
  reason: string;
};

export async function cancelOrder(
  database: typeof Db,
  input: CancelOrderInput,
): Promise<{ orderId: string; previousStatus: OrderStatus }> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    columns: { id: true, status: true, groupId: true },
  });
  if (!order) {
    throw new AppError(404, ErrorCode.OrderNotFound, `Order ${input.orderId} not found`);
  }
  const previousStatus = order.status as OrderStatus;
  if (isTerminal(previousStatus)) {
    throw new AppError(
      409,
      ErrorCode.OrderCancellationNotAllowed,
      `Order ${input.orderId} is already in terminal state '${previousStatus}'`,
    );
  }

  // Release reserved stock: every item that hasn't already been finalised (delivered/closed)
  // is still holding its reservation.
  await database.transaction(async (tx) => {
    const items = await tx
      .select({ variantId: orderItems.variantId, qty: orderItems.qty })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));
    for (const it of items) {
      await tx
        .update(variants)
        .set({ reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)` })
        .where(eq(variants.id, it.variantId));
    }
  });

  await transitionOrder(database, {
    orderId: input.orderId,
    toStatus: 'cancelled',
    actorType: input.actorType,
    actorId: input.actorId,
    reason: input.reason,
    metadata: { previousStatus },
  });

  return { orderId: input.orderId, previousStatus };
}
