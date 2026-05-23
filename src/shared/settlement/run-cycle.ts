/**
 * §18 — Payout cycle creation. Idempotent on (storeId, cycleEnd).
 *
 * `previewCycle` returns the aggregate without writing.
 * `runCycle` writes a payout row + attaches active holds + unattached adjustments + audit row.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  payoutAdjustments,
  payoutHolds,
  payoutTransitions,
  payouts,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { newId } from '@/shared/ids.js';
import { computeCycleAggregate, type CycleAggregate } from './payout-math.js';

export type RunCycleInput = {
  storeId: string;
  cycleStart: Date;
  cycleEnd: Date;
  bankAccountId: string;
  actor: { type: 'admin' | 'system'; id: string };
};

export type RunCycleResult = {
  payoutId: string;
  aggregate: CycleAggregate;
  alreadyExisted: boolean;
};

export async function previewCycle(input: {
  storeId: string;
  cycleStart: Date;
  cycleEnd: Date;
}): Promise<CycleAggregate> {
  return await computeCycleAggregate(input);
}

export async function runCycle(input: RunCycleInput): Promise<RunCycleResult> {
  const aggregate = await computeCycleAggregate({
    storeId: input.storeId,
    cycleStart: input.cycleStart,
    cycleEnd: input.cycleEnd,
  });

  if (aggregate.netPaise < 0n) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cycle net amount is negative (${aggregate.netPaise}); cannot create payout`,
    );
  }

  return await db.transaction(async (tx) => {
    // Idempotency: refuse if a payout exists for the same cycleEnd.
    const existing = await tx.query.payouts.findFirst({
      where: and(eq(payouts.storeId, input.storeId), eq(payouts.cycleEnd, input.cycleEnd)),
    });
    if (existing) {
      return {
        payoutId: existing.id,
        aggregate,
        alreadyExisted: true,
      };
    }

    const payoutId = newId('pyo');
    await tx.insert(payouts).values({
      id: payoutId,
      storeId: input.storeId,
      cycleStart: input.cycleStart,
      cycleEnd: input.cycleEnd,
      grossPaise: aggregate.grossPaise,
      commissionPaise: aggregate.commissionPaise,
      commissionTaxPaise: aggregate.commissionTaxPaise,
      refundsHeldPaise: aggregate.refundsHeldPaise,
      adjustmentsPaise: aggregate.adjustmentsPaise,
      disputeHoldPaise: aggregate.disputeHoldPaise,
      netPaise: aggregate.netPaise,
      bankAccountId: input.bankAccountId,
      status: 'pending',
    });

    // Attach active holds.
    if (aggregate.activeHoldIds.length > 0) {
      await tx
        .update(payoutHolds)
        .set({ payoutId })
        .where(inArray(payoutHolds.id, aggregate.activeHoldIds));
    }

    // Attach unattached adjustments.
    if (aggregate.unattachedAdjustmentIds.length > 0) {
      await tx
        .update(payoutAdjustments)
        .set({ payoutId })
        .where(inArray(payoutAdjustments.id, aggregate.unattachedAdjustmentIds));
    }

    // Audit row.
    await tx.insert(payoutTransitions).values({
      id: newId('pyt'),
      payoutId,
      fromStatus: null,
      toStatus: 'pending',
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: 'cycle_run',
    });

    return { payoutId, aggregate, alreadyExisted: false };
  });
}
