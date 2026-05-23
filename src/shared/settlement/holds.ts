/**
 * §18 — Dispute holds. Active holds are pulled into the next runCycle and bound to that payout.
 * Release: mark released; if linked to a pending payout, decrement its disputeHoldPaise + netPaise.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { payoutHolds, payouts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { newId } from '@/shared/ids.js';

export async function createHold(input: {
  storeId: string;
  disputeId: string;
  amountPaise: bigint | number;
  reason: string;
  adminId: string;
}): Promise<{ holdId: string }> {
  const id = newId('phd');
  await db.insert(payoutHolds).values({
    id,
    storeId: input.storeId,
    disputeId: input.disputeId,
    amountPaise: typeof input.amountPaise === 'bigint' ? input.amountPaise : BigInt(input.amountPaise),
    reason: input.reason,
    status: 'active',
    createdByAdminId: input.adminId,
  });
  return { holdId: id };
}

export async function releaseHold(input: {
  holdId: string;
  reason: string;
  adminId: string;
}): Promise<{ holdId: string; rebalancedPayoutId: string | null }> {
  return await db.transaction(async (tx) => {
    const hold = await tx.query.payoutHolds.findFirst({
      where: eq(payoutHolds.id, input.holdId),
    });
    if (!hold) throw new AppError(404, ErrorCode.NotFound, 'Hold not found');
    if (hold.status !== 'active') {
      throw new AppError(409, ErrorCode.InvalidState, `Hold is '${hold.status}', not 'active'`);
    }

    await tx
      .update(payoutHolds)
      .set({
        status: 'released',
        releasedAt: new Date(),
        releasedReason: input.reason,
      })
      .where(eq(payoutHolds.id, input.holdId));

    // If bound to a pending payout, decrement that payout's disputeHoldPaise and recompute net.
    let rebalancedPayoutId: string | null = null;
    if (hold.payoutId) {
      const payout = await tx.query.payouts.findFirst({ where: eq(payouts.id, hold.payoutId) });
      if (payout) {
        if (payout.status !== 'pending') {
          throw new AppError(
            409,
            ErrorCode.InvalidState,
            `Cannot rebalance payout ${payout.id}: status is '${payout.status}'`,
          );
        }
        await tx
          .update(payouts)
          .set({
            disputeHoldPaise: payout.disputeHoldPaise - hold.amountPaise,
            netPaise: payout.netPaise + hold.amountPaise,
          })
          .where(eq(payouts.id, payout.id));
        rebalancedPayoutId = payout.id;
      }
    }

    void input.adminId;
    return { holdId: input.holdId, rebalancedPayoutId };
  });
}

/** Helper for the (future) dispute-resolution hook. Releases all active holds on a dispute. */
export async function autoReleaseHoldsForDispute(disputeId: string, adminId: string): Promise<number> {
  const active = await db.query.payoutHolds.findMany({
    where: and(eq(payoutHolds.disputeId, disputeId), eq(payoutHolds.status, 'active')),
  });
  for (const h of active) {
    await releaseHold({ holdId: h.id, reason: 'dispute_resolved', adminId });
  }
  return active.length;
}
