/**
 * §18 — Payout state machine. Allowed transitions:
 *   pending → processing
 *   processing → completed | failed
 *   failed → processing (retry; bumps retry_count, sets previous_payout_id chain via new row)
 * Mark-complete writes bank_confirmation_ref + bank_confirmed_at.
 * Each transition fires a notification to the store accounts.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { payoutTransitions, payouts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { newId } from '@/shared/ids.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';

type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed';

const ALLOWED: Record<PayoutStatus, PayoutStatus[]> = {
  pending: ['processing'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['processing'],
};

export async function transitionPayout(input: {
  payoutId: string;
  toStatus: PayoutStatus;
  actor: { type: 'admin' | 'system'; id: string };
  reason?: string;
  bankConfirmationRef?: string;
  failureReason?: string;
}): Promise<{ payoutId: string; toStatus: PayoutStatus }> {
  const { payoutId, toStatus } = input;
  const row = await db.query.payouts.findFirst({ where: eq(payouts.id, payoutId) });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');
  const from = row.status as PayoutStatus;
  if (!ALLOWED[from].includes(toStatus)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot transition payout from '${from}' to '${toStatus}'`,
    );
  }

  const now = new Date();
  const update: Partial<typeof payouts.$inferInsert> = { status: toStatus };
  if (toStatus === 'processing') {
    update.initiatedAt = now;
    // Simulated gateway reference assigned on initiate (if first time).
    if (!row.gatewayPayoutId) {
      update.gatewayPayoutId = `PAY-SIM-${payoutId.slice(-10)}`;
    }
  }
  if (toStatus === 'completed') {
    update.completedAt = now;
    if (input.bankConfirmationRef) {
      update.bankConfirmationRef = input.bankConfirmationRef;
      update.bankConfirmedAt = now;
    }
  }
  if (toStatus === 'failed') {
    update.failureReason = input.failureReason ?? input.reason ?? 'unspecified';
  }

  await db.transaction(async (tx) => {
    await tx.update(payouts).set(update).where(eq(payouts.id, payoutId));
    await tx.insert(payoutTransitions).values({
      id: newId('pyt'),
      payoutId,
      fromStatus: from,
      toStatus,
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: input.reason ?? null,
      at: now,
    });
  });

  // Notifications (best-effort).
  try {
    if (toStatus === 'processing') {
      await notifyStoreAccounts({
        storeId: row.storeId,
        kind: 'payout',
        title: 'Payout initiated',
        body: `Payout of ₹${Number(row.netPaise) / 100} sent to bank`,
        deepLink: `/payouts/${payoutId}`,
        payload: { payoutId, status: 'processing' },
      });
    }
    if (toStatus === 'completed') {
      await notifyStoreAccounts({
        storeId: row.storeId,
        kind: 'payout',
        title: input.bankConfirmationRef ? 'Bank confirmed payout receipt' : 'Payout processed',
        body: input.bankConfirmationRef
          ? `Reference: ${input.bankConfirmationRef}`
          : 'Funds credited to your bank',
        deepLink: `/payouts/${payoutId}`,
        payload: { payoutId, status: 'completed', bankConfirmationRef: input.bankConfirmationRef },
      });
    }
    if (toStatus === 'failed') {
      await notifyStoreAccounts({
        storeId: row.storeId,
        kind: 'payout',
        title: 'Payout failed',
        body: `Reason: ${update.failureReason}. Please update bank details and request retry.`,
        deepLink: `/payouts/${payoutId}`,
        payload: { payoutId, status: 'failed', failureReason: update.failureReason },
      });
      // §22 — admin queue must surface failed payouts.
      await notifyAllAdmins({
        kind: 'payout',
        title: 'Payout failed',
        body: `Store ${row.storeId}: ${update.failureReason}`,
        deepLink: `/admin/payouts/${payoutId}`,
        payload: { payoutId, storeId: row.storeId, failureReason: update.failureReason },
      });
    }
  } catch (err) {
    console.error(
      `[settlement] notification dispatch failed for payout ${payoutId}: ${(err as Error).message}`,
    );
  }

  return { payoutId, toStatus };
}

/**
 * Retry a failed payout. Creates a NEW payout row chained via previous_payout_id, mirroring
 * amounts. Original payout stays 'failed' for audit.
 */
export async function retryPayout(input: {
  payoutId: string;
  actor: { type: 'admin' | 'system'; id: string };
}): Promise<{ newPayoutId: string }> {
  const row = await db.query.payouts.findFirst({ where: eq(payouts.id, input.payoutId) });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');
  if (row.status !== 'failed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only failed payouts can be retried');
  }
  const newPayoutId = newId('pyo');
  await db.transaction(async (tx) => {
    await tx.insert(payouts).values({
      id: newPayoutId,
      storeId: row.storeId,
      cycleStart: row.cycleStart,
      cycleEnd: row.cycleEnd,
      grossPaise: row.grossPaise,
      commissionPaise: row.commissionPaise,
      commissionTaxPaise: row.commissionTaxPaise,
      refundsHeldPaise: row.refundsHeldPaise,
      adjustmentsPaise: row.adjustmentsPaise,
      disputeHoldPaise: row.disputeHoldPaise,
      netPaise: row.netPaise,
      bankAccountId: row.bankAccountId,
      status: 'pending',
      retryCount: row.retryCount + 1,
      previousPayoutId: row.id,
    });
    await tx.insert(payoutTransitions).values({
      id: newId('pyt'),
      payoutId: newPayoutId,
      fromStatus: null,
      toStatus: 'pending',
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: `retry_of_${row.id}`,
    });
  });
  return { newPayoutId };
}
