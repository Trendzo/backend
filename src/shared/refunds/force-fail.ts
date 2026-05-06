/**
 * Admin force-fail a refund disbursement. Used to test the retry chain since the simulated
 * gateway always succeeds at creation time. Reverses any wallet credit if the destination
 * was wallet, then writes a fresh disbursement with `previousDisbursementId` chain.
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  consumerWallets,
  refundDisbursements,
  refunds,
  walletTransactions,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
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
      let attempt = 0;
      while (attempt < 3) {
        const wallet = await tx.query.consumerWallets.findFirst({
          where: eq(consumerWallets.consumerId, order.consumerId),
        });
        if (!wallet) throw new AppError(500, ErrorCode.InternalError, 'Wallet vanished');
        const newBalance = wallet.balancePaise - d.amountPaise;
        if (newBalance < 0) {
          throw new AppError(
            409,
            ErrorCode.ExceedsBalance,
            'Wallet balance would go negative on reversal',
          );
        }
        const newVersion = wallet.version + 1;
        const [updated] = await tx
          .update(consumerWallets)
          .set({ balancePaise: newBalance, version: newVersion, updatedAt: new Date() })
          .where(and(eq(consumerWallets.id, wallet.id), eq(consumerWallets.version, wallet.version)))
          .returning();
        if (updated) {
          await tx.insert(walletTransactions).values({
            id: newId(IdPrefix.WalletTx),
            walletId: wallet.id,
            kind: 'adjustment',
            amountPaise: -d.amountPaise,
            balanceAfterPaise: newBalance,
            walletVersionAfter: newVersion,
            refOrderId: order.id,
            note: `Reversal of disbursement ${input.disbursementId} (force-fail)`,
          });
          break;
        }
        attempt += 1;
      }
      if (attempt >= 3) {
        throw new AppError(503, ErrorCode.InternalError, 'Wallet CAS retries exhausted');
      }
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

    // Roll up parent refund status.
    await tx
      .update(refunds)
      .set({ status: 'partially_disbursed' })
      .where(eq(refunds.id, d.refundId));
  });

  return {
    disbursementId: input.disbursementId,
    refundId: d.refundId,
    retryDisbursementId: newPendingId,
  };
}
