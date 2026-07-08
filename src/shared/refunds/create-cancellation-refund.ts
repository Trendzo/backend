/**
 * Full-order refund for a cancelled order — DB-only money movement, mirroring the
 * simulated-disbursement pattern of `createRefundForReturns`.
 *
 * Base = money truth, not line-sum:
 *   refundable = (walletAppliedPaise + Σ succeeded payments) − Σ prior refunds
 * A base ≤ 0 returns null — that single check is both the skip for unpaid orders
 * (COD not collected, payment pending/failed) AND the idempotency guard: a second
 * cancellation refund computes zero and creates nothing.
 *
 * The header total is the full paid remainder (it exceeds the item-line sum by
 * the paid fees — delivery/handling); refund_lines carry the per-item breakdown
 * for lines not already refunded by a prior per-return refund. Settlement
 * payout-math and credit-note issuance read header and lines independently.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  consumerWallets,
  orderItems,
  orders,
  payments,
  refundDisbursements,
  refundLines,
  refunds,
  walletTransactions,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';
import { ensureWallet } from '@/shared/wallet/ensure-wallet.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';

export async function createRefundForCancellation(
  database: typeof Db,
  input: { orderId: string; reason: string; actor: { type: ActorType; id: string } },
): Promise<{ refundId: string; totalRefundPaise: number; disbursementIds: string[] } | null> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');

  // ── Money truth: what was actually paid vs already refunded ──
  const succeededPayments = await database.query.payments.findMany({
    where: and(eq(payments.orderId, order.id), eq(payments.status, 'succeeded')),
    columns: { id: true, amountPaise: true, settledAt: true },
  });
  const paidPaise =
    order.walletAppliedPaise + succeededPayments.reduce((s, p) => s + p.amountPaise, 0);

  const priorRefunds = await database.query.refunds.findMany({
    where: eq(refunds.orderId, order.id),
    columns: { id: true, totalRefundPaise: true, status: true },
  });
  const alreadyRefundedPaise = priorRefunds
    .filter((r) => r.status !== 'failed')
    .reduce((s, r) => s + r.totalRefundPaise, 0);

  const refundable = paidPaise - alreadyRefundedPaise;
  if (refundable <= 0) return null;

  // ── Per-item lines for items not already refunded by a prior refund ──
  const items = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, order.id),
  });
  const priorRefundIds = priorRefunds.map((r) => r.id);
  const priorLines = priorRefundIds.length
    ? await database.query.refundLines.findMany({
        where: inArray(refundLines.refundId, priorRefundIds),
        columns: { orderItemId: true },
      })
    : [];
  const alreadyRefundedItemIds = new Set(priorLines.map((l) => l.orderItemId));
  const lineRows = items
    .filter((it) => !alreadyRefundedItemIds.has(it.id))
    .map((it) => ({
      orderItemId: it.id,
      refundedAmountPaise: it.netLinePaise,
      couponClawbackPaise: it.couponAllocPaise,
      pointsClawbackPaise: it.pointsAllocPaise,
      taxRefundPaise: it.gstAllocPaise,
    }));

  // ── Disbursement split: wallet first (net of prior wallet disbursements), rest simulated ──
  const priorWalletBackPaise = priorRefundIds.length
    ? (
        await database.query.refundDisbursements.findMany({
          where: and(
            inArray(refundDisbursements.refundId, priorRefundIds),
            eq(refundDisbursements.destination, 'wallet'),
            eq(refundDisbursements.status, 'succeeded'),
          ),
          columns: { amountPaise: true },
        })
      ).reduce((s, d) => s + d.amountPaise, 0)
    : 0;
  const walletPortion = Math.min(
    Math.max(order.walletAppliedPaise - priorWalletBackPaise, 0),
    refundable,
  );
  const originalTenderPortion = refundable - walletPortion;

  let sourcePaymentId: string | null = null;
  if (originalTenderPortion > 0) {
    const latest = [...succeededPayments].sort(
      (a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0),
    )[0];
    sourcePaymentId = latest?.id ?? null;
    if (!sourcePaymentId) {
      // Defensive: originalTenderPortion > 0 implies a succeeded payment exists.
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
    await tx.insert(refunds).values({
      id: refundId,
      orderId: order.id,
      totalRefundPaise: refundable,
      status: 'processing',
      reason: input.reason,
    });

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

    if (walletPortion > 0) {
      const walletId = await ensureWallet(tx, order.consumerId);
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
            note: `Cancellation refund ${refundId}`,
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

    await tx
      .update(refunds)
      .set({ status: 'succeeded', completedAt: new Date() })
      .where(eq(refunds.id, refundId));
  });

  // Loyalty: restore redeemed points (full pre-delivery; proportional earn clawback
  // capped at live balance post-delivery). Same post-tx placement as create-refund.ts.
  const pointsRedeemedClawback = lineRows.reduce((acc, ln) => acc + ln.pointsClawbackPaise, 0);
  const refundedLinesTotal = lineRows.reduce((acc, ln) => acc + ln.refundedAmountPaise, 0);
  const { creditBackOnRefund } = await import('@/shared/loyalty/grant.js');
  await creditBackOnRefund({
    orderId: order.id,
    refundId,
    pointsRedeemedClawbackPaise: pointsRedeemedClawback,
    refundedLinesTotalPaise: refundedLinesTotal,
  });

  // Credit note — usually a no-op pre-delivery (no parent tax invoice yet).
  try {
    const { issueCreditNoteForRefund } = await import('@/shared/invoicing/issuance.js');
    await issueCreditNoteForRefund({ refundId, reason: input.reason });
  } catch (err) {
    console.error(
      `[invoicing] credit note on cancellation refund ${refundId}: ${(err as Error).message}`,
    );
  }

  await notifyConsumer({
    consumerId: order.consumerId,
    kind: 'refund',
    title: 'Refund initiated',
    body: `₹${(refundable / 100).toFixed(2)} is on its way back to your ${walletPortion === refundable ? 'wallet' : 'original payment method'}.`,
    deepLink: `/orders/${order.id}`,
    payload: { orderId: order.id, refundId, totalRefundPaise: refundable },
  }).catch(() => undefined);

  return { refundId, totalRefundPaise: refundable, disbursementIds };
}
