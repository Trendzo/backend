/**
 * Auto-create the 3-table refund tree for accepted returns.
 *
 * Strategy:
 *   1. For each return: load its order_item; refundedAmountPaise = netLinePaise.
 *      coupon/points/tax allocations carry over from the original line allocation.
 *   2. Sum across all returns → totalRefundPaise on the parent refund.
 *   3. Disbursement split (proportional to original payment tenders):
 *        - walletAppliedPaise > 0 → wallet disbursement
 *        - remainder → original tender (pick the most recent succeeded payment for sourcePaymentId)
 *   4. Wallet disbursement: CAS-credit the consumer's wallet, write wallet_transaction with
 *      kind='refund_credit', mark disbursement succeeded immediately.
 *   5. Original-tender disbursement: simulate gateway success — gatewayRef='REFUND-TEST-{ulid}',
 *      status='succeeded', settledAt=now.
 *   6. Roll up refund.status: all-succeeded → 'succeeded'; otherwise 'partially_disbursed'.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  consumerWallets,
  orders,
  payments,
  refundDisbursements,
  refundLines,
  refunds,
  returns,
  walletTransactions,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';

export async function createRefundForReturns(
  database: typeof Db,
  input: {
    orderId: string;
    returnIds: string[];
    reason: string;
    actor: { type: ActorType; id: string };
  },
): Promise<{
  refundId: string;
  totalRefundPaise: number;
  disbursementIds: string[];
}> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');

  const retRows = await database.query.returns.findMany({
    where: inArray(returns.id, input.returnIds),
    with: { orderItem: true },
  });
  if (retRows.length !== input.returnIds.length) {
    throw new AppError(404, ErrorCode.ReturnNotFound, 'One or more returns not found');
  }

  // Sum totals + per-return breakdowns.
  let total = 0;
  const lineRows: Array<{
    orderItemId: string;
    refundedAmountPaise: number;
    couponClawbackPaise: number;
    pointsClawbackPaise: number;
    taxRefundPaise: number;
  }> = [];
  for (const r of retRows) {
    const it = r.orderItem;
    const refundAmount = it.netLinePaise;
    total += refundAmount;
    lineRows.push({
      orderItemId: it.id,
      refundedAmountPaise: refundAmount,
      couponClawbackPaise: it.couponAllocPaise,
      pointsClawbackPaise: it.pointsAllocPaise,
      taxRefundPaise: it.gstAllocPaise,
    });
  }

  // Disbursement split. Wallet portion: clamped to min(walletAppliedPaise, total).
  const walletPortion = Math.min(order.walletAppliedPaise, total);
  const originalTenderPortion = total - walletPortion;

  // Pick the most recent succeeded payment for original-tender disbursement.
  let sourcePaymentId: string | null = null;
  if (originalTenderPortion > 0) {
    const succeeded = await database.query.payments.findFirst({
      where: and(eq(payments.orderId, order.id), eq(payments.status, 'succeeded')),
      orderBy: (p, { desc }) => desc(p.settledAt),
    });
    sourcePaymentId = succeeded?.id ?? null;
    if (!sourcePaymentId) {
      throw new AppError(
        409,
        ErrorCode.PaymentFailed,
        'No succeeded payment found to refund the original-tender portion against',
      );
    }
  }

  const refundId = newId(IdPrefix.Refund);
  const disbursementIds: string[] = [];

  await database.transaction(async (tx) => {
    // refund header
    await tx.insert(refunds).values({
      id: refundId,
      orderId: order.id,
      totalRefundPaise: total,
      status: 'processing',
      reason: input.reason,
    });

    // refund_lines
    for (const ln of lineRows) {
      await tx.insert(refundLines).values({
        id: newId(IdPrefix.RefundLine),
        refundId,
        orderItemId: ln.orderItemId,
        refundedAmountPaise: ln.refundedAmountPaise,
        couponClawbackPaise: ln.couponClawbackPaise,
        pointsClawbackPaise: ln.pointsClawbackPaise,
        taxRefundPaise: ln.taxRefundPaise,
      });
    }

    // wallet disbursement (auto-succeed via CAS)
    if (walletPortion > 0) {
      const walletId = await ensureWallet(tx, order.consumerId);
      // CAS credit
      let attempt = 0;
      while (attempt < 3) {
        const wallet = await tx.query.consumerWallets.findFirst({
          where: eq(consumerWallets.id, walletId),
        });
        if (!wallet) throw new AppError(500, ErrorCode.InternalError, 'Wallet vanished');
        const newBalance = wallet.balancePaise + walletPortion;
        const newVersion = wallet.version + 1;
        const [updated] = await tx
          .update(consumerWallets)
          .set({ balancePaise: newBalance, version: newVersion, updatedAt: new Date() })
          .where(and(eq(consumerWallets.id, walletId), eq(consumerWallets.version, wallet.version)))
          .returning();
        if (updated) {
          await tx.insert(walletTransactions).values({
            id: newId(IdPrefix.WalletTx),
            walletId,
            kind: 'refund_credit',
            amountPaise: walletPortion,
            balanceAfterPaise: newBalance,
            walletVersionAfter: newVersion,
            refOrderId: order.id,
            note: `Refund credit ${refundId}`,
          });
          break;
        }
        attempt += 1;
      }
      if (attempt >= 3) {
        throw new AppError(503, ErrorCode.InternalError, 'Wallet CAS retries exhausted');
      }

      const did = newId(IdPrefix.RefundDisbursement);
      disbursementIds.push(did);
      await tx.insert(refundDisbursements).values({
        id: did,
        refundId,
        destination: 'wallet',
        sourcePaymentId: null,
        amountPaise: walletPortion,
        status: 'succeeded',
        gatewayRef: null,
        settledAt: new Date(),
      });
    }

    // original-tender disbursement (auto-succeed simulated)
    if (originalTenderPortion > 0 && sourcePaymentId) {
      const did = newId(IdPrefix.RefundDisbursement);
      disbursementIds.push(did);
      await tx.insert(refundDisbursements).values({
        id: did,
        refundId,
        destination: 'original_tender',
        sourcePaymentId,
        amountPaise: originalTenderPortion,
        status: 'succeeded',
        gatewayRef: `REFUND-TEST-${did.slice(4, 16)}`,
        settledAt: new Date(),
      });
    }

    // Roll up refund status
    await tx
      .update(refunds)
      .set({ status: 'succeeded', completedAt: new Date() })
      .where(eq(refunds.id, refundId));
  });

  return { refundId, totalRefundPaise: total, disbursementIds };
}

async function ensureWallet(
  tx: Parameters<Parameters<typeof Db.transaction>[0]>[0],
  consumerId: string,
): Promise<string> {
  const existing = await tx.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, consumerId),
  });
  if (existing) return existing.id;
  const id = newId(IdPrefix.WalletTx).replace(/^wtx_/, 'wlt_');
  const [created] = await tx
    .insert(consumerWallets)
    .values({ id, consumerId, balancePaise: 0, version: 0 })
    .returning();
  return created!.id;
}

void sql;
