/**
 * Cancellation orchestrator. Validates the actor + state via the state machine,
 * releases reservations still held by never-finalized items, fails any pending
 * (COD) payment, logs the cancellation transition, and creates the DB-only
 * cancellation refund for whatever was actually paid (wallet portion CAS-credited
 * back; original-tender disbursement simulated — no gateway exists).
 *
 * Promo/voucher redemption counters are deliberately NOT reverted on cancel:
 * `promotion_redemptions` rows are the immutable consumption audit (same stance
 * as accepted partial returns), and reverting would enable place→cancel coupon
 * farming.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { createRefundForCancellation } from '@/shared/refunds/create-cancellation-refund.js';
import { failPendingPaymentsOnCancel } from '@/shared/payments/settle-cod.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { releaseUnfinalizedReservations } from './release-reservations.js';
import { transitionOrder } from './transition.js';
import { canTransition, isTerminal, type ActorType, type OrderStatus } from './state-machine.js';

export type CancelOrderInput = {
  orderId: string;
  actorType: ActorType;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown> | undefined;
};

export async function cancelOrder(
  database: typeof Db,
  input: CancelOrderInput,
): Promise<{ orderId: string; previousStatus: OrderStatus; refundId: string | null }> {
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
  // Validate BEFORE any side effect — previously reservations were released and
  // only then the transition 409'd, leaking the release.
  if (!canTransition(previousStatus, 'cancelled', input.actorType)) {
    throw new AppError(
      409,
      ErrorCode.OrderCancellationNotAllowed,
      `Order ${input.orderId} cannot be cancelled from '${previousStatus}' by ${input.actorType}`,
    );
  }

  // Release reservations for items that never finalized (outcome-scoped — an
  // admin cancel of a delivered order must not touch other orders' reservations).
  await releaseUnfinalizedReservations(database, input.orderId);

  await transitionOrder(database, {
    orderId: input.orderId,
    toStatus: 'cancelled',
    actorType: input.actorType,
    actorId: input.actorId,
    reason: input.reason,
    metadata: { previousStatus, ...(input.metadata ?? {}) },
  });

  // Post-transition, best-effort: a failure here must not strand the order
  // un-cancelled. The refund helper's paid−refunded base is idempotent, so a
  // later retry (or sweep) self-heals a missed refund.
  await failPendingPaymentsOnCancel(database, input.orderId).catch((err) => {
    console.error(`[cancel] fail-pending-payments ${input.orderId}: ${(err as Error).message}`);
  });
  const refund = await createRefundForCancellation(database, {
    orderId: input.orderId,
    reason: `order_cancelled:${input.reason}`,
    actor: { type: input.actorType, id: input.actorId },
  }).catch((err) => {
    console.error(`[cancel] cancellation refund ${input.orderId}: ${(err as Error).message}`);
    void notifyAllAdmins({
      kind: 'system',
      title: 'Cancellation refund failed',
      body: `Order ${input.orderId}: ${(err as Error).message}`,
      payload: { orderId: input.orderId },
    }).catch(() => undefined);
    return null;
  });

  return { orderId: input.orderId, previousStatus, refundId: refund?.refundId ?? null };
}
