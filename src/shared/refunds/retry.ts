/**
 * Admin retry of a pending disbursement (created by force-fail or manual).
 * Wallet legs credit immediately; original-tender legs go through the active
 * gateway (real Razorpay refund when configured, simulated otherwise).
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  consumerWallets,
  payments,
  refundDisbursements,
  refunds,
  walletTransactions,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { settleTenderDisbursement } from '@/shared/refunds/disburse-tender.js';
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
    if (d.destination === 'wallet') {
      await tx
        .update(refundDisbursements)
        .set({ status: 'succeeded', settledAt: new Date() })
        .where(eq(refundDisbursements.id, input.disbursementId));
    }

    // Roll up: are all *leaf* disbursements for this refund succeeded?
    // A leaf is one that is not superseded by a later retry in the chain.
    // (Tender legs settle post-tx via the gateway; their own settle re-rolls-up.)
    const allDisb = await tx.query.refundDisbursements.findMany({
      where: eq(refundDisbursements.refundId, d.refundId),
    });
    const supersededIds = new Set(
      allDisb.map((x) => x.previousDisbursementId).filter(Boolean),
    );
    const leafDisb = allDisb.filter((x) => !supersededIds.has(x.id));
    const allSucceeded = leafDisb.every(
      (x) => x.status === 'succeeded' || (x.id === d.id && d.destination === 'wallet'),
    );
    if (allSucceeded) {
      await tx
        .update(refunds)
        .set({ status: 'succeeded', completedAt: new Date() })
        .where(eq(refunds.id, d.refundId));
    }
  });

  // Original-tender leg: real gateway refund when active (simulated otherwise).
  if (d.destination === 'original_tender') {
    const source = d.sourcePaymentId
      ? await database.query.payments.findFirst({
          where: eq(payments.id, d.sourcePaymentId),
          columns: { gatewayRef: true },
        })
      : null;
    const outcome = await settleTenderDisbursement(database, {
      refundId: d.refundId,
      disbursementId: d.id,
      amountPaise: d.amountPaise,
      sourceGatewayRef: source?.gatewayRef ?? null,
    });
    if (outcome === 'failed') {
      throw new AppError(502, ErrorCode.PaymentFailed, 'Gateway refund failed — see admin alerts');
    }
  }

  return { disbursementId: input.disbursementId, refundId: d.refundId, outcome: 'succeeded' };
}
