/**
 * §18 — payout cycle aggregation.
 *
 * Iterates over delivered orders for the given store in the [cycleStart, cycleEnd) window,
 * computes gross, commission (per-order snap), GST on commission (18% — accountant default),
 * deducts refunds attached to those orders, applies active dispute holds, and applies
 * unattached `payout_adjustments` for the store.
 */
import { and, eq, gte, isNull, lt, or, sum } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  orders,
  payoutAdjustments,
  payoutHolds,
  payouts,
  refunds,
} from '@/db/schema/index.js';

export type CycleAggregate = {
  grossPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  /** Platform-funded discounts on this cycle's orders, paid back to the retailer. */
  discountReimbursementPaise: bigint;
  refundsHeldPaise: bigint;
  adjustmentsPaise: bigint; // signed: manual-kind only (credit+, debit-)
  disputeLiabilitiesPaise: bigint; // signed: dispute_liability-kind only
  disputeHoldPaise: bigint;
  tcsPaise: bigint;
  netPaise: bigint;
  orderCount: number;
  includedOrderIds: string[];
  activeHoldIds: string[];
  unattachedAdjustmentIds: string[];
};

const COMMISSION_GST_RATE_BP = 1800; // 18% (intra-state combines CGST+SGST or inter-state IGST)

export async function computeCycleAggregate(input: {
  storeId: string;
  cycleStart: Date;
  cycleEnd: Date;
}): Promise<CycleAggregate> {
  const { storeId, cycleStart, cycleEnd } = input;

  // Delivered orders within the cycle window. Use deliveredAt for the bucket.
  const cycleOrders = await db
    .select({
      id: orders.id,
      itemsSubtotalPaise: orders.itemsSubtotalPaise,
      grandTotalPaise: orders.grandTotalPaise,
      // The four components netted out of grandTotalPaise. Reimbursed to the retailer:
      // Trendzo funds promotions, the retailer does not.
      retailerPromoPaise: orders.retailerPromoPaise,
      platformPromoPaise: orders.platformPromoPaise,
      couponPaise: orders.couponPaise,
      pointsRedeemedPaise: orders.pointsRedeemedPaise,
      taxPaise: orders.taxPaise,
      platformFeeBpSnap: orders.platformFeeBpSnap,
      tcsRateBpSnap: orders.tcsRateBpSnap,
      deliveredAt: orders.deliveredAt,
      status: orders.status,
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.status, 'delivered'),
        gte(orders.deliveredAt, cycleStart),
        lt(orders.deliveredAt, cycleEnd),
      ),
    );

  let grossPaise = 0n;
  let discountReimbursementPaise = 0n;
  let commissionPaise = 0n;
  let tcsPaise = 0n;
  const orderIds: string[] = [];
  for (const o of cycleOrders) {
    grossPaise += BigInt(o.grandTotalPaise);

    /**
     * Add back every discount that reduced grandTotalPaise.
     *
     * grandTotalPaise is built on `taxBasePaise = postPromoSubtotal − coupon − loyalty`
     * (discounts/compute.ts:192-223), so paying out on it alone meant the retailer
     * funded every promotion the platform ran — while commission and TCS were charged
     * on the pre-discount `itemsSubtotalPaise`, so a discounted order cost the retailer
     * twice. Trendzo bears promotion cost, so the retailer is made whole here.
     *
     * `walletAppliedPaise` is deliberately NOT included: wallet is a tender applied on
     * top of grandTotal, not a discount, so it never reduced this base.
     *
     * All four buckets are reimbursed today because nothing in the system is genuinely
     * retailer-funded yet — `promotions.issuerType` records who CREATED a promotion, not
     * who pays for it, and no code reads it for money. When an explicit funding flag
     * lands, retailer-funded promotions get excluded from this sum and nothing else here
     * needs to change.
     */
    discountReimbursementPaise += BigInt(
      o.retailerPromoPaise + o.platformPromoPaise + o.couponPaise + o.pointsRedeemedPaise,
    );

    // Commission and TCS stay on the pre-discount subtotal. That was previously
    // inconsistent with a post-discount payout base; with the reimbursement above, both
    // sides of the ledger now sit on the same pre-discount value.
    const commission = Math.floor((o.itemsSubtotalPaise * o.platformFeeBpSnap) / 10_000);
    commissionPaise += BigInt(commission);
    const tcs = Math.floor((o.itemsSubtotalPaise * o.tcsRateBpSnap) / 10_000);
    tcsPaise += BigInt(tcs);
    orderIds.push(o.id);
  }
  const commissionTaxPaise = (commissionPaise * BigInt(COMMISSION_GST_RATE_BP)) / 10_000n;

  /**
   * Refunds tied to those orders.
   *
   * This deducted EVERY refund row regardless of status: the `status='succeeded'`
   * filter was applied to a first query whose result was then thrown away with
   * `void refundRows`, while the loop summed a second, unfiltered query. Pending and
   * failed refunds were being taken out of retailer payouts — money the consumer never
   * received. The filter now lives on the query that is actually summed.
   */
  let refundsHeldPaise = 0n;
  if (orderIds.length > 0) {
    const idSet = new Set(orderIds);
    const refundOrderRows = await db
      .select({ amount: refunds.totalRefundPaise, orderId: refunds.orderId })
      .from(refunds)
      .where(eq(refunds.status, 'succeeded'));
    for (const r of refundOrderRows) {
      if (idSet.has(r.orderId)) refundsHeldPaise += BigInt(r.amount);
    }
  }

  // Active holds (unattached or pre-attached to this future payout — we treat any active hold for the store).
  const activeHolds = await db
    .select({
      id: payoutHolds.id,
      amountPaise: payoutHolds.amountPaise,
      payoutId: payoutHolds.payoutId,
    })
    .from(payoutHolds)
    .where(and(eq(payoutHolds.storeId, storeId), eq(payoutHolds.status, 'active'), isNull(payoutHolds.payoutId)));
  let disputeHoldPaise = 0n;
  const activeHoldIds: string[] = [];
  for (const h of activeHolds) {
    disputeHoldPaise += h.amountPaise;
    activeHoldIds.push(h.id);
  }

  // Unattached adjustments. Split by kind: dispute_liability vs manual.
  const unattachedAdjustments = await db
    .select({
      id: payoutAdjustments.id,
      direction: payoutAdjustments.direction,
      kind: payoutAdjustments.kind,
      amountPaise: payoutAdjustments.amountPaise,
    })
    .from(payoutAdjustments)
    .where(and(eq(payoutAdjustments.storeId, storeId), isNull(payoutAdjustments.payoutId)));
  let adjustmentsPaise = 0n;
  let disputeLiabilitiesPaise = 0n;
  const unattachedAdjustmentIds: string[] = [];
  for (const a of unattachedAdjustments) {
    const signed = a.direction === 'credit' ? a.amountPaise : -a.amountPaise;
    if (a.kind === 'dispute_liability') {
      disputeLiabilitiesPaise += signed;
    } else {
      adjustmentsPaise += signed;
    }
    unattachedAdjustmentIds.push(a.id);
  }

  // Net = gross + discountReimbursement − commission − commissionTax − refundsHeld − tcs
  //       − holds + adjustments + disputeLiabilities
  const netPaise =
    grossPaise +
    discountReimbursementPaise -
    commissionPaise -
    commissionTaxPaise -
    refundsHeldPaise -
    tcsPaise -
    disputeHoldPaise +
    adjustmentsPaise +
    disputeLiabilitiesPaise;

  return {
    grossPaise,
    commissionPaise,
    commissionTaxPaise,
    discountReimbursementPaise,
    refundsHeldPaise,
    adjustmentsPaise,
    disputeLiabilitiesPaise,
    disputeHoldPaise,
    tcsPaise,
    netPaise,
    orderCount: cycleOrders.length,
    includedOrderIds: orderIds,
    activeHoldIds,
    unattachedAdjustmentIds,
  };
}

void payouts;
void or;
void sum;
