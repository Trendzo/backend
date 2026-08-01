/**
 * Build the 3-table refund tree for accepted returns.
 *
 * Split across the commit boundary that already existed in this file:
 *
 *   createRefundForReturnsTx   — pure DB work. Safe to run inside a caller's
 *                                transaction, which is what lets `verifyReturn`
 *                                accept-and-refund atomically. Before this split the
 *                                accept committed first and a refund failure left a
 *                                return permanently accepted + restocked with no
 *                                refund, and no sweep ever revisited it.
 *   settleRefundPostCommit     — network + cross-module effects (gateway call,
 *                                loyalty credit-back, credit note). MUST run after
 *                                commit; never throws.
 *   createRefundForReturns     — unchanged public signature, wraps both.
 *
 * Amounts come from `loadRefundBasis`, the same money truth the cancellation path
 * uses: items already carried by a prior refund are dropped (idempotency), the total
 * is capped at what is actually still refundable, and the wallet portion is netted
 * against wallet money already returned — so two partial returns can no longer each
 * re-claim the full `walletAppliedPaise`.
 */
import { inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements, refundLines, refunds, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { isRazorpayActive } from '@/shared/payments/razorpay.js';
import { simulatedMoneyAllowed } from '@/shared/payments/simulation-guard.js';
import { claimCashHandover } from '@/shared/refunds/claim-cash-handover.js';
import { settleTenderDisbursement } from '@/shared/refunds/disburse-tender.js';
import { resolveTenderDestination } from '@/shared/refunds/resolve-destination.js';
import {
  loadRefundBasis,
  requireSourcePayment,
  splitRefundTenders,
} from '@/shared/refunds/refund-basis.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';
import { applyWalletDelta } from '@/shared/wallet/apply-delta.js';
import type { ActorType } from '@/shared/orders/state-machine.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type CreateReturnRefundInput = {
  orderId: string;
  returnIds: string[];
  reason: string;
  actor: { type: ActorType; id: string };
};

/** Everything the post-commit stage needs, so it never re-reads a half-written tree. */
export type RefundPostCommit = {
  refundId: string;
  orderId: string;
  totalRefundPaise: number;
  disbursementIds: string[];
  /** The leg still needing a post-commit settlement attempt, if any. */
  tenderDisbursementId: string | null;
  tenderPortionPaise: number;
  tenderDestination: 'original_tender' | 'manual_payout' | null;
  sourceGatewayRef: string | null;
  pointsRedeemedClawbackPaise: number;
  refundedLinesTotalPaise: number;
  reason: string;
};

/**
 * Refund amount that WOULD be due for these returns, without creating anything.
 * Used to size the payout hold when a return is disputed, and to size the cash a
 * driver carries to a COD reverse pickup. Mirrors the per-item sum below.
 */
export async function quoteReturnRefundPaise(
  database: typeof Db,
  returnIds: string[],
): Promise<number> {
  if (returnIds.length === 0) return 0;
  const retRows = await database.query.returns.findMany({
    where: inArray(returns.id, returnIds),
    with: { orderItem: true },
  });
  return retRows.reduce((sum, r) => sum + r.orderItem.netLinePaise, 0);
}

/**
 * All DB work for a return refund. Returns `null` when there is nothing left to
 * refund — every item already refunded, or no money left on the order. That null is
 * the idempotency guard: a replayed accept creates no second refund tree.
 */
export async function createRefundForReturnsTx(
  tx: Tx,
  input: CreateReturnRefundInput,
): Promise<RefundPostCommit | null> {
  const basis = await loadRefundBasis(tx, input.orderId);

  const retRows = await tx.query.returns.findMany({
    where: inArray(returns.id, input.returnIds),
    with: { orderItem: true },
  });
  if (retRows.length !== input.returnIds.length) {
    throw new AppError(404, ErrorCode.ReturnNotFound, 'One or more returns not found');
  }

  // Drop items a prior refund already covered — this is what makes a replay a no-op
  // instead of a second payout.
  const eligible = retRows.filter((r) => !basis.priorRefundedItemIds.has(r.orderItem.id));
  if (eligible.length === 0) return null;

  const lineRows = eligible.map((r) => ({
    orderItemId: r.orderItem.id,
    refundedAmountPaise: r.orderItem.netLinePaise,
    couponClawbackPaise: r.orderItem.couponAllocPaise,
    pointsClawbackPaise: r.orderItem.pointsAllocPaise,
    taxRefundPaise: r.orderItem.gstAllocPaise,
  }));
  const linesTotal = lineRows.reduce((s, ln) => s + ln.refundedAmountPaise, 0);

  // Never hand back more than the order still owes. On a normal paid order the cap
  // is slack (paid includes fees); it only bites when the order was under-collected,
  // where the disbursements — not the line sum — are the money truth.
  const total = Math.min(linesTotal, basis.refundablePaise);
  if (total <= 0) return null;

  const { walletPortion, originalTenderPortion } = splitRefundTenders(basis, total);
  const sourcePayment = originalTenderPortion > 0 ? requireSourcePayment(basis) : null;

  const refundId = newId(IdPrefix.Refund);
  const disbursementIds: string[] = [];
  let tenderDisbursementId: string | null = null;

  await tx.insert(refunds).values({
    id: refundId,
    orderId: basis.orderId,
    totalRefundPaise: total,
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

  // Wallet leg — the money moves here, inside the transaction, so it succeeds or
  // rolls back with the accept.
  if (walletPortion > 0) {
    await applyWalletDelta(tx, {
      consumerId: basis.consumerId,
      deltaPaise: walletPortion,
      kind: 'refund_credit',
      refOrderId: basis.orderId,
      refRefundId: refundId,
      note: `Refund credit ${refundId}`,
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

  // Non-wallet leg. The RAIL is decided here, when the row is written, so the settler
  // never has to guess and can never fall through into a fabricated success.
  let tenderDestination: 'original_tender' | 'manual_payout' | null = null;
  if (originalTenderPortion > 0 && sourcePayment) {
    const rail = resolveTenderDestination({
      sourceGatewayRef: sourcePayment.gatewayRef,
      sourcePaymentMethod: sourcePayment.method,
      channel: 'return',
      handover: null, // resolved per-claim below; presence is decided by claimCashHandover
      gatewayActive: isRazorpayActive(),
      simulationAllowed: simulatedMoneyAllowed(),
    });

    if (rail.destination === 'cash') {
      // Cash the driver already handed at collection settles the leg immediately, dated
      // to the moment the money actually changed hands. Anything not yet handed becomes
      // a pending cash leg for the counter or the admin desk.
      const claims = await claimCashHandover(tx, {
        orderId: basis.orderId,
        returnIds: input.returnIds,
        maxPaise: originalTenderPortion,
      });
      let claimed = 0;
      for (const c of claims) {
        const did = newId(IdPrefix.RefundDisbursement);
        disbursementIds.push(did);
        await tx.insert(refundDisbursements).values({
          id: did,
          refundId,
          destination: 'cash',
          sourcePaymentId: sourcePayment.id,
          amountPaise: c.amountPaise,
          status: 'succeeded',
          gatewayRef: `CASH-${c.handoverId.slice(4, 16)}`,
          settledAt: c.handedAt,
          cashHandoverId: c.handoverId,
        });
        claimed += c.amountPaise;
      }
      const outstanding = originalTenderPortion - claimed;
      if (outstanding > 0) {
        const did = newId(IdPrefix.RefundDisbursement);
        disbursementIds.push(did);
        await tx.insert(refundDisbursements).values({
          id: did,
          refundId,
          destination: 'cash',
          sourcePaymentId: sourcePayment.id,
          amountPaise: outstanding,
          status: 'pending',
        });
      }
    } else {
      const did = newId(IdPrefix.RefundDisbursement);
      disbursementIds.push(did);
      tenderDisbursementId = did;
      tenderDestination = rail.destination;
      await tx.insert(refundDisbursements).values({
        id: did,
        refundId,
        destination: rail.destination,
        sourcePaymentId: sourcePayment.id,
        amountPaise: originalTenderPortion,
        status: 'pending',
        ...(rail.destination === 'manual_payout' ? { settlementNote: rail.reason } : {}),
      });
    }
  }

  await rollUpRefundStatus(tx, refundId);

  return {
    refundId,
    orderId: basis.orderId,
    totalRefundPaise: total,
    disbursementIds,
    tenderDisbursementId,
    tenderPortionPaise: originalTenderPortion,
    tenderDestination,
    sourceGatewayRef: sourcePayment?.gatewayRef ?? null,
    pointsRedeemedClawbackPaise: lineRows.reduce((acc, ln) => acc + ln.pointsClawbackPaise, 0),
    refundedLinesTotalPaise: total,
    reason: input.reason,
  };
}

/**
 * Network + cross-module effects for a committed refund. Never throws: the money is
 * already recorded, so a loyalty or invoicing hiccup must not surface as a 500 that
 * makes the caller think the refund failed.
 */
export async function settleRefundPostCommit(
  database: typeof Db,
  p: RefundPostCommit,
): Promise<void> {
  if (p.tenderDisbursementId && p.tenderDestination && p.tenderPortionPaise > 0) {
    try {
      await settleTenderDisbursement(database, {
        refundId: p.refundId,
        disbursementId: p.tenderDisbursementId,
        amountPaise: p.tenderPortionPaise,
        sourceGatewayRef: p.sourceGatewayRef,
        destination: p.tenderDestination,
      });
    } catch (err) {
      // Leg stays 'pending' and the refund-integrity sweep retries it.
      console.error(
        `[refunds] tender settle failed for refund ${p.refundId}: ${(err as Error).message}`,
      );
    }
  }

  // §14 L3 — loyalty credit-back (restore redeemed points) + earn claw-back
  // (proportional). Bypasses the rewards-ban check: restoration is not a fresh reward.
  try {
    const { creditBackOnRefund } = await import('@/shared/loyalty/grant.js');
    await creditBackOnRefund({
      orderId: p.orderId,
      refundId: p.refundId,
      pointsRedeemedClawbackPaise: p.pointsRedeemedClawbackPaise,
      refundedLinesTotalPaise: p.refundedLinesTotalPaise,
    });
  } catch (err) {
    console.error(
      `[loyalty] credit-back failed for refund ${p.refundId}: ${(err as Error).message}`,
    );
  }

  // §17 — credit note against the parent tax invoice. Often a no-op (the invoice may
  // not exist yet). Idempotent on refundId so a manual retry stays safe.
  try {
    const { issueCreditNoteForRefund } = await import('@/shared/invoicing/issuance.js');
    await issueCreditNoteForRefund({ refundId: p.refundId, reason: p.reason });
  } catch (err) {
    console.error(
      `[invoicing] auto-issue credit note failed for refund ${p.refundId}: ${(err as Error).message}`,
    );
  }
}

export async function createRefundForReturns(
  database: typeof Db,
  input: CreateReturnRefundInput,
): Promise<{ refundId: string; totalRefundPaise: number; disbursementIds: string[] } | null> {
  const post = await database.transaction((tx) => createRefundForReturnsTx(tx, input));
  if (!post) return null;
  await settleRefundPostCommit(database, post);
  return {
    refundId: post.refundId,
    totalRefundPaise: post.totalRefundPaise,
    disbursementIds: post.disbursementIds,
  };
}
