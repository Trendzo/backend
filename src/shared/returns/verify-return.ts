/**
 * Store verification of a return. Two outcomes:
 *
 *   accepted → returns.storeDecision='accepted'; order_item.outcome='store_accepted_return';
 *              triggers refund auto-creation (createRefundForReturns) + order finalize.
 *   rejected → returns.storeDecision='rejected'; order_item.outcome='store_rejected_held';
 *              creates a held_items row in 'holding' state. (Admin path only — the
 *              RETAILER decline path is declineReturn, which also opens a dispute and
 *              holds funds; the retailer route is restricted to accept-only.)
 *
 * Same function services Drop-A door-returns AND Drop-B post-delivery returns. Caller scopes
 * by storeId for the retailer route; admin route accepts any return.
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { heldItems, orderItems, platformConfig, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';
import { createRefundForReturns } from '@/shared/refunds/create-refund.js';
import { applyAcceptedReturnStockEffect } from '@/shared/returns/restock.js';
import { recomputeAfterPartialReturn } from '@/shared/orders/recompute-on-return.js';
import { finalizeReturnedOrder } from '@/shared/orders/finalize-return.js';

export async function verifyReturn(
  database: typeof Db,
  input: {
    returnId: string;
    decision: 'accepted' | 'rejected';
    reasonNote?: string | undefined;
    /** Store-side evidence photos. Persisted on rejection; ignored on acceptance. */
    rejectPhotos?: string[] | undefined;
    actor: { type: ActorType; id: string };
    /** When set, retailer-side caller asserting ownership. */
    expectedStoreId?: string | undefined;
  },
): Promise<{
  returnId: string;
  decision: 'accepted' | 'rejected';
  refundId: string | null;
  heldItemId: string | null;
}> {
  const ret = await database.query.returns.findFirst({
    where: eq(returns.id, input.returnId),
    with: { orderItem: { with: { order: true } } },
  });
  if (!ret) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
  if (ret.storeDecision !== 'pending') {
    throw new AppError(409, ErrorCode.ReturnAlreadyDecided, `Return is already in '${ret.storeDecision}'`);
  }
  const order = ret.orderItem.order;
  if (input.expectedStoreId && order.storeId !== input.expectedStoreId) {
    throw new AppError(403, ErrorCode.Forbidden, 'Return does not belong to your store');
  }

  const now = new Date();

  if (input.decision === 'accepted') {
    await database.transaction(async (tx) => {
      // Conditional flip = the double-application guard for the stock effect
      // (a concurrent decline/accept loses here and the 409 surfaces).
      const [flipped] = await tx
        .update(returns)
        .set({ storeDecision: 'accepted', storeDecidedAt: now })
        .where(and(eq(returns.id, input.returnId), eq(returns.storeDecision, 'pending')))
        .returning({ id: returns.id });
      if (!flipped) {
        throw new AppError(409, ErrorCode.ReturnAlreadyDecided, 'Return is already decided');
      }
      await tx
        .update(orderItems)
        .set({ outcome: 'store_accepted_return' })
        .where(eq(orderItems.id, ret.orderItemId));
      // Goods are back with the store: standard returns restock (they were
      // stock-finalized at delivery); door returns release the reservation
      // (never finalized — shelf count already includes them).
      await applyAcceptedReturnStockEffect(tx, {
        returnKind: ret.kind,
        variantId: ret.orderItem.variantId,
        qty: ret.orderItem.qty,
      });
    });
    const refund = await createRefundForReturns(database, {
      orderId: order.id,
      returnIds: [input.returnId],
      reason: input.reasonNote ?? `Accepted return ${input.returnId}`,
      actor: input.actor,
    });
    await recomputeAfterPartialReturn(database, order.id).catch(() => undefined);
    await finalizeReturnedOrder(database, order.id, input.actor).catch(() => undefined);
    return { returnId: input.returnId, decision: 'accepted', refundId: refund.refundId, heldItemId: null };
  }

  // Rejected (admin path): shelve the goods, no refund.
  const cfg = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'holding_window_days'),
  });
  const holdingDays = cfg && typeof cfg.value === 'number' ? cfg.value : 14;
  const expiresAt = new Date(now.getTime() + holdingDays * 24 * 60 * 60 * 1000);
  const heldId = newId(IdPrefix.HeldItem);
  await database.transaction(async (tx) => {
    const [flipped] = await tx
      .update(returns)
      .set({ storeDecision: 'rejected', storeDecidedAt: now, storeRejectPhotos: input.rejectPhotos ?? [] })
      .where(and(eq(returns.id, input.returnId), eq(returns.storeDecision, 'pending')))
      .returning({ id: returns.id });
    if (!flipped) {
      throw new AppError(409, ErrorCode.ReturnAlreadyDecided, 'Return is already decided');
    }
    await tx
      .update(orderItems)
      .set({ outcome: 'store_rejected_held' })
      .where(eq(orderItems.id, ret.orderItemId));
    await tx.insert(heldItems).values({
      id: heldId,
      returnId: input.returnId,
      storeId: order.storeId,
      consumerId: order.consumerId,
      status: 'holding',
      holdingWindowExpiresAt: expiresAt,
    });
  });
  return { returnId: input.returnId, decision: 'rejected', refundId: null, heldItemId: heldId };
}
