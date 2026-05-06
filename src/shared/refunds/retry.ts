/**
 * Admin retry of a pending disbursement (created by force-fail or manual). Auto-succeeds the
 * disbursement using the same simulated path as create-refund.ts.
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

export async function retryDisbursement(
  database: typeof Db,
  input: {
    disbursementId: string;
    actor: { type: ActorType; id: string };
  },
): Promise<{ disbursementId: string; refundId: string; outcome: 'succeeded' }> {
  const d = await database.query.refundDisbursements.findFirst({
    where: eq(refundDisbursements.id, input.disbursementId),
    with: { refund: { with: { order: true } } },
  });
  if (!d) throw new AppError(404, ErrorCode.DisbursementNotFound, 'Disbursement not found');
  if (d.status !== 'pending') {
    throw new AppError(
      409,
      ErrorCode.DisbursementAlreadyTerminal,
      `Cannot retry disbursement in '${d.status}' status`,
    );
  }

  await database.transaction(async (tx) => {
    if (d.destination === 'wallet') {
      // Credit wallet now.
      let attempt = 0;
      while (attempt < 3) {
        const wallet = await tx.query.consumerWallets.findFirst({
          where: eq(consumerWallets.consumerId, d.refund.order.consumerId),
        });
        if (!wallet) throw new AppError(500, ErrorCode.InternalError, 'Wallet vanished');
        const newBalance = wallet.balancePaise + d.amountPaise;
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
            kind: 'refund_credit',
            amountPaise: d.amountPaise,
            balanceAfterPaise: newBalance,
            walletVersionAfter: newVersion,
            refOrderId: d.refund.orderId,
            note: `Refund retry ${d.id}`,
          });
          break;
        }
        attempt += 1;
      }
      if (attempt >= 3) {
        throw new AppError(503, ErrorCode.InternalError, 'Wallet CAS retries exhausted');
      }
    }
    await tx
      .update(refundDisbursements)
      .set({
        status: 'succeeded',
        gatewayRef:
          d.destination === 'original_tender'
            ? `REFUND-TEST-${d.id.slice(4, 16)}`
            : null,
        settledAt: new Date(),
      })
      .where(eq(refundDisbursements.id, input.disbursementId));

    // Roll up: are all disbursements for this refund succeeded?
    const allDisb = await tx.query.refundDisbursements.findMany({
      where: eq(refundDisbursements.refundId, d.refundId),
    });
    const allSucceeded = allDisb.every((x) => x.status === 'succeeded' || x.id === d.id);
    if (allSucceeded) {
      await tx
        .update(refunds)
        .set({ status: 'succeeded', completedAt: new Date() })
        .where(eq(refunds.id, d.refundId));
    }
  });

  return { disbursementId: input.disbursementId, refundId: d.refundId, outcome: 'succeeded' };
}
