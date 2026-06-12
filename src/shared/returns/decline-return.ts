/**
 * Retailer declines a customer return. Per spec, a decline is NOT a unilateral
 * rejection — it opens a dispute and freezes funds until an admin decides:
 *
 *   - return.storeDecision='rejected', orderItem.outcome='store_rejected_held'
 *   - the goods are shelved (held_items, 'holding')
 *   - a dispute issue (kind='dispute') is opened, linked to the return
 *   - a payout hold is placed on the disputed amount so the retailer is NOT
 *     paid out for it; the consumer refund is inherently withheld (none is
 *     created on decline). Both sides stay frozen until decideIssue runs.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { heldItems, orderItems, platformConfig, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';
import { createIssue } from '@/shared/issues/index.js';
import { createHold } from '@/shared/settlement/holds.js';
import { quoteReturnRefundPaise } from '@/shared/refunds/create-refund.js';

export async function declineReturn(
  database: typeof Db,
  input: {
    returnId: string;
    reasonNote?: string | undefined;
    rejectPhotos?: string[] | undefined;
    actor: { type: ActorType; id: string };
    expectedStoreId?: string | undefined;
  },
): Promise<{ returnId: string; issueId: string; heldItemId: string; holdId: string }> {
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
  const cfg = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'holding_window_days'),
  });
  const holdingDays = cfg && typeof cfg.value === 'number' ? cfg.value : 14;
  const expiresAt = new Date(now.getTime() + holdingDays * 24 * 60 * 60 * 1000);
  const heldId = newId(IdPrefix.HeldItem);
  const disputedPaise = await quoteReturnRefundPaise(database, [input.returnId]);

  // Shelve the goods + mark the return rejected (pending dispute resolution).
  await database.transaction(async (tx) => {
    await tx
      .update(returns)
      .set({ storeDecision: 'rejected', storeDecidedAt: now, storeRejectPhotos: input.rejectPhotos ?? [] })
      .where(eq(returns.id, input.returnId));
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

  // Open the dispute (kind='dispute') linked to the return.
  const { issueId } = await createIssue({
    storeId: order.storeId,
    kind: 'dispute',
    returnId: input.returnId,
    openedByActorType: input.actor.type,
    openedByActorId: input.actor.id,
    subject: 'Return declined by store',
    description: input.reasonNote ?? 'Store declined the return; awaiting admin decision.',
    evidence: input.rejectPhotos ?? [],
  });

  // Freeze the disputed amount on the retailer's payout until the admin decides.
  const { holdId } = await createHold({
    storeId: order.storeId,
    disputeId: issueId,
    amountPaise: disputedPaise,
    reason: `return_disputed:${input.returnId}`,
    adminId: input.actor.id,
  });

  return { returnId: input.returnId, issueId, heldItemId: heldId, holdId };
}
