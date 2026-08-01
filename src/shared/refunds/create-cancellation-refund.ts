/**
 * Full-order refund for a cancelled order.
 *
 * Base = money truth, not line-sum:
 *   refundable = (walletAppliedPaise + Σ succeeded payments) − Σ prior refunds
 * A base ≤ 0 returns null — that single check is both the skip for unpaid orders
 * (COD not collected, payment pending/failed) AND the idempotency guard: a second
 * cancellation refund computes zero and creates nothing.
 *
 * The header total is the full paid remainder (it exceeds the item-line sum by the
 * paid fees — delivery/handling); refund_lines carry the per-item breakdown for lines
 * not already refunded by a prior per-return refund. Settlement payout-math and
 * credit-note issuance read header and lines independently.
 *
 * All of the arithmetic now lives in `loadRefundBasis`/`splitRefundTenders`, shared
 * with the returns path.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderItems, refundDisbursements, refundLines, refunds } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { isRazorpayActive } from '@/shared/payments/razorpay.js';
import { simulatedMoneyAllowed } from '@/shared/payments/simulation-guard.js';
import { resolveTenderDestination } from '@/shared/refunds/resolve-destination.js';
import type { ActorType } from '@/shared/orders/state-machine.js';
import { settleRefundPostCommit, type RefundPostCommit } from '@/shared/refunds/create-refund.js';
import {
  loadRefundBasis,
  requireSourcePayment,
  splitRefundTenders,
} from '@/shared/refunds/refund-basis.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';
import { applyWalletDelta } from '@/shared/wallet/apply-delta.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';

export async function createRefundForCancellation(
  database: typeof Db,
  input: { orderId: string; reason: string; actor: { type: ActorType; id: string } },
): Promise<{ refundId: string; totalRefundPaise: number; disbursementIds: string[] } | null> {
  const basis = await loadRefundBasis(database, input.orderId);
  const refundable = basis.refundablePaise;
  if (refundable <= 0) return null;

  // ── Per-item lines for items not already refunded by a prior refund ──
  const items = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, basis.orderId),
  });
  const lineRows = items
    .filter((it) => !basis.priorRefundedItemIds.has(it.id))
    .map((it) => ({
      orderItemId: it.id,
      refundedAmountPaise: it.netLinePaise,
      couponClawbackPaise: it.couponAllocPaise,
      pointsClawbackPaise: it.pointsAllocPaise,
      taxRefundPaise: it.gstAllocPaise,
    }));

  const { walletPortion, originalTenderPortion } = splitRefundTenders(basis, refundable);
  const sourcePayment = originalTenderPortion > 0 ? requireSourcePayment(basis) : null;

  const refundId = newId(IdPrefix.Refund);
  const disbursementIds: string[] = [];
  let tenderDisbursementId: string | null = null;
  let tenderDestination: 'original_tender' | 'manual_payout' | null = null;

  await database.transaction(async (tx) => {
    await tx.insert(refunds).values({
      id: refundId,
      orderId: basis.orderId,
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
      await applyWalletDelta(tx, {
        consumerId: basis.consumerId,
        deltaPaise: walletPortion,
        kind: 'refund_credit',
        refOrderId: basis.orderId,
        refRefundId: refundId,
        note: `Cancellation refund ${refundId}`,
      });
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

    // Non-wallet leg, rail decided at write time. A cancellation has nobody visiting
    // the customer, so a COD order resolves to `manual_payout` and parks on the admin
    // desk rather than silently "completing" with no money moved.
    if (originalTenderPortion > 0 && sourcePayment) {
      const rail = resolveTenderDestination({
        sourceGatewayRef: sourcePayment.gatewayRef,
        sourcePaymentMethod: sourcePayment.method,
        channel: 'cancellation',
        handover: null,
        gatewayActive: isRazorpayActive(),
        simulationAllowed: simulatedMoneyAllowed(),
      });
      const destination = rail.destination === 'cash' ? 'manual_payout' : rail.destination;
      const did = newId(IdPrefix.RefundDisbursement);
      disbursementIds.push(did);
      tenderDisbursementId = did;
      tenderDestination = destination;
      await tx.insert(refundDisbursements).values({
        id: did,
        refundId,
        destination,
        sourcePaymentId: sourcePayment.id,
        amountPaise: originalTenderPortion,
        status: 'pending',
        ...(rail.destination === 'manual_payout' ? { settlementNote: rail.reason } : {}),
      });
    }

    await rollUpRefundStatus(tx, refundId);
  });

  // Loyalty clawback is sized by the item lines actually refunded here, not by the
  // fee-inclusive header total.
  const post: RefundPostCommit = {
    refundId,
    orderId: basis.orderId,
    totalRefundPaise: refundable,
    disbursementIds,
    tenderDisbursementId,
    tenderPortionPaise: originalTenderPortion,
    tenderDestination,
    sourceGatewayRef: sourcePayment?.gatewayRef ?? null,
    pointsRedeemedClawbackPaise: lineRows.reduce((acc, ln) => acc + ln.pointsClawbackPaise, 0),
    refundedLinesTotalPaise: lineRows.reduce((acc, ln) => acc + ln.refundedAmountPaise, 0),
    reason: input.reason,
  };
  await settleRefundPostCommit(database, post);

  await notifyConsumer({
    consumerId: basis.consumerId,
    kind: 'refund',
    title: 'Refund initiated',
    body: `₹${(refundable / 100).toFixed(2)} is on its way back to your ${walletPortion === refundable ? 'wallet' : 'original payment method'}.`,
    deepLink: `/orders/${basis.orderId}`,
    payload: { orderId: basis.orderId, refundId, totalRefundPaise: refundable },
  }).catch(() => undefined);

  return { refundId, totalRefundPaise: refundable, disbursementIds };
}
