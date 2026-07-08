/**
 * Single funnel for every order status mutation. Validates against the state machine,
 * writes the audit row, updates the timestamp column matched to the destination status,
 * and recomputes the parent group's rollup. Inside one transaction.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orders, orderTransitions } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recomputeGroupStatus } from './rollup.js';
import { assertTransition, type ActorType, type OrderStatus } from './state-machine.js';

export type TransitionInput = {
  orderId: string;
  toStatus: OrderStatus;
  actorType: ActorType;
  /** Polymorphic actor id. 'system' literal when actorType='system'. */
  actorId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type TransitionResult = {
  orderId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  transitionId: string;
};

/**
 * Apply a transition. Throws OrderNotFound if the order id is unknown, OrderTransitionInvalid
 * if the actor cannot move from the current status to the target.
 */
export async function transitionOrder(
  database: typeof Db,
  input: TransitionInput,
): Promise<TransitionResult> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    columns: { id: true, status: true, groupId: true },
  });
  if (!order) {
    throw new AppError(404, ErrorCode.NotFound, `Order ${input.orderId} not found`);
  }
  const from = order.status as OrderStatus;
  try {
    assertTransition(from, input.toStatus, input.actorType);
  } catch {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot transition order ${input.orderId} from '${from}' to '${input.toStatus}' as ${input.actorType}`,
    );
  }

  // Write the new status + the matching timestamp column.
  const now = new Date();
  const update: Partial<typeof orders.$inferInsert> = { status: input.toStatus };
  if (input.toStatus === 'accepted') update.acceptedAt = now;
  if (input.toStatus === 'packed') update.packedAt = now;
  if (input.toStatus === 'delivered') update.deliveredAt = now;
  if (input.toStatus === 'closed') update.closedAt = now;

  await database.update(orders).set(update).where(eq(orders.id, input.orderId));

  const transitionId = newId(IdPrefix.OrderTransition);
  await database.insert(orderTransitions).values({
    id: transitionId,
    orderId: input.orderId,
    fromStatus: from,
    toStatus: input.toStatus,
    actorType: input.actorType,
    actorId: input.actorId,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    at: now,
  });

  await recomputeGroupStatus(database, order.groupId);

  // §14 L3 — credit loyalty points on delivery. Idempotent; skipped if rewards-banned.
  if (input.toStatus === 'delivered') {
    const { grantLoyaltyOnDelivery } = await import('@/shared/loyalty/grant.js');
    await grantLoyaltyOnDelivery(input.orderId);

    // §17 — issue consumer tax invoice. Idempotent; failures must not roll back delivery.
    try {
      const { issueInvoiceForOrder } = await import('@/shared/invoicing/issuance.js');
      await issueInvoiceForOrder({ orderId: input.orderId, kind: 'tax_invoice' });
    } catch (err) {
      console.error(
        `[invoicing] auto-issue on delivery failed for order ${input.orderId}: ${(err as Error).message}`,
      );
    }

    // §18 — issue per-order commission invoice. Idempotent on (orderId, kind).
    try {
      const { issueCommissionInvoiceForOrder } = await import(
        '@/shared/settlement/commission-invoice.js'
      );
      await issueCommissionInvoiceForOrder({ orderId: input.orderId });
    } catch (err) {
      console.error(
        `[settlement] commission invoice on delivery failed for order ${input.orderId}: ${(err as Error).message}`,
      );
    }
  }

  return { orderId: input.orderId, fromStatus: from, toStatus: input.toStatus, transitionId };
}

/**
 * Append-only transition log row WITHOUT changing the status. Useful for "cancel
 * requested" markers and other annotations the audit trail benefits from.
 */
export async function logTransitionMarker(
  database: typeof Db,
  input: TransitionInput,
): Promise<{ transitionId: string }> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    columns: { id: true, status: true },
  });
  if (!order) {
    throw new AppError(404, ErrorCode.NotFound, `Order ${input.orderId} not found`);
  }
  const transitionId = newId(IdPrefix.OrderTransition);
  await database.insert(orderTransitions).values({
    id: transitionId,
    orderId: input.orderId,
    fromStatus: order.status as OrderStatus,
    toStatus: input.toStatus,
    actorType: input.actorType,
    actorId: input.actorId,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    at: new Date(),
  });
  return { transitionId };
}
