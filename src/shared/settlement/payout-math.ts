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
  let commissionPaise = 0n;
  let tcsPaise = 0n;
  const orderIds: string[] = [];
  for (const o of cycleOrders) {
    grossPaise += BigInt(o.grandTotalPaise);
    const commission = Math.floor((o.itemsSubtotalPaise * o.platformFeeBpSnap) / 10_000);
    commissionPaise += BigInt(commission);
    const tcs = Math.floor((o.itemsSubtotalPaise * o.tcsRateBpSnap) / 10_000);
    tcsPaise += BigInt(tcs);
    orderIds.push(o.id);
  }
  const commissionTaxPaise = (commissionPaise * BigInt(COMMISSION_GST_RATE_BP)) / 10_000n;

  // Refunds tied to those orders. Sum of refunds.totalRefundPaise where order in cycle.
  let refundsHeldPaise = 0n;
  if (orderIds.length > 0) {
    const refundRows = await db
      .select({ amount: refunds.totalRefundPaise })
      .from(refunds)
      .where(and(eq(refunds.status, 'succeeded')));
    // crude filter to keep things simple — re-filter by order in JS to avoid SQL IN with many ids
    const idSet = new Set(orderIds);
    const refundOrderRows = await db
      .select({ amount: refunds.totalRefundPaise, orderId: refunds.orderId })
      .from(refunds);
    for (const r of refundOrderRows) {
      if (idSet.has(r.orderId)) refundsHeldPaise += BigInt(r.amount);
    }
    void refundRows;
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

  // Net = gross − commission − commissionTax − refundsHeld − tcs − holds + adjustments + disputeLiabilities
  const netPaise =
    grossPaise -
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
