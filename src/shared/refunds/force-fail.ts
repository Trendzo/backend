/**
 * Admin force-fail a refund disbursement. Used to test the retry chain since the simulated
 * gateway always succeeds at creation time. Reverses any wallet credit if the destination
 * was wallet, then writes a fresh disbursement with `previousDisbursementId` chain.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';
import { applyWalletDelta } from '@/shared/wallet/apply-delta.js';
import type { ActorType } from '@/shared/orders/state-machine.js';

export async function forceFailDisbursement(
  database: typeof Db,
  input: {
    disbursementId: string;
    reason: string;
    actor: { type: ActorType; id: string };
  },
): Promise<{
  disbursementId: string;
  refundId: string;
  retryDisbursementId: string;
}> {
  const d = await database.query.refundDisbursements.findFirst({
    where: eq(refundDisbursements.id, input.disbursementId),
    with: { refund: { with: { order: true } } },
  });
  if (!d) {
    throw new AppError(404, ErrorCode.DisbursementNotFound, 'Disbursement not found');
  }
  if (d.status === 'failed') {
    throw new AppError(
      409,
      ErrorCode.DisbursementAlreadyTerminal,
      'Disbursement is already failed',
    );
  }

  const order = d.refund.order;
  const newPendingId = newId(IdPrefix.RefundDisbursement);

  await database.transaction(async (tx) => {
    // Mark this disbursement as failed.
    await tx
      .update(refundDisbursements)
      .set({ status: 'failed', settledAt: new Date() })
      .where(eq(refundDisbursements.id, input.disbursementId));

    // If the failed disbursement was a wallet credit AND it was succeeded, reverse the wallet.
    if (d.destination === 'wallet' && d.status === 'succeeded') {
      await applyWalletDelta(tx, {
        consumerId: order.consumerId,
        deltaPaise: -d.amountPaise,
        kind: 'adjustment',
        refOrderId: order.id,
        refRefundId: d.refundId,
        note: `Reversal of disbursement ${input.disbursementId} (force-fail)`,
        insufficientMessage: 'Wallet balance would go negative on reversal',
      });
    }

    // Insert a fresh pending disbursement chained back.
    await tx.insert(refundDisbursements).values({
      id: newPendingId,
      refundId: d.refundId,
      destination: d.destination,
      sourcePaymentId: d.sourcePaymentId,
      amountPaise: d.amountPaise,
      status: 'pending',
      gatewayRef: null,
      previousDisbursementId: input.disbursementId,
    });

    // Roll up parent refund status over the leaves — the failed leg is now superseded
    // by the fresh pending one, so this reads 'processing' (or 'partially_disbursed'
    // when a sibling leg already landed), never a stale 'succeeded'.
    await rollUpRefundStatus(tx, d.refundId);
  });

  return {
    disbursementId: input.disbursementId,
    refundId: d.refundId,
    retryDisbursementId: newPendingId,
  };
}
