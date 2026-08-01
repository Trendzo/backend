/**
 * "Is there cash the store still owes this customer?"
 *
 * A COD refund settles as physical cash. When nobody has handed it over yet the refund
 * carries a `cash` disbursement in `pending`. The retailer portal needs to find that leg
 * to pay it — and until this existed it could not: the retailer return endpoints returned
 * the return and its held items but no refund and no disbursements, so the
 * `pay-cash` route was unreachable by construction (the disbursement id was undiscoverable).
 *
 * Superseded retry legs are filtered out via `leavesOf`, so a leg some earlier attempt
 * already replaced can never be presented as still owing.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements, refunds } from '@/db/schema/index.js';
import { leavesOf } from '@/shared/refunds/rollup.js';

export type CashRefundDue = {
  refundId: string;
  disbursementId: string;
  amountPaise: number;
};

/**
 * Oldest unpaid cash leg per order, or absent when nothing is owed.
 *
 * One leg at a time, deliberately: `settleCashAtCounter` demands an exact per-leg amount,
 * so paying them individually is what the rail supports. Batch-loaded — the returns list
 * calls this once for the whole page rather than per row.
 */
export async function cashRefundDueByOrder(
  database: typeof Db,
  orderIds: string[],
): Promise<Map<string, CashRefundDue>> {
  const out = new Map<string, CashRefundDue>();
  if (orderIds.length === 0) return out;

  const refundRows = await database.query.refunds.findMany({
    where: inArray(refunds.orderId, orderIds),
    columns: { id: true, orderId: true },
  });
  if (refundRows.length === 0) return out;

  const legs = await database.query.refundDisbursements.findMany({
    where: and(
      inArray(
        refundDisbursements.refundId,
        refundRows.map((r) => r.id),
      ),
      eq(refundDisbursements.destination, 'cash'),
    ),
    columns: {
      id: true,
      refundId: true,
      amountPaise: true,
      status: true,
      previousDisbursementId: true,
      initiatedAt: true,
    },
  });
  if (legs.length === 0) return out;

  const orderOf = new Map(refundRows.map((r) => [r.id, r.orderId]));
  const pending = leavesOf(legs)
    .filter((d) => d.status === 'pending')
    .sort((a, b) => a.initiatedAt.getTime() - b.initiatedAt.getTime());

  for (const d of pending) {
    const orderId = orderOf.get(d.refundId);
    if (!orderId || out.has(orderId)) continue; // oldest wins
    out.set(orderId, {
      refundId: d.refundId,
      disbursementId: d.id,
      amountPaise: d.amountPaise,
    });
  }
  return out;
}

/** Single-order convenience for the detail endpoint. */
export async function cashRefundDueForOrder(
  database: typeof Db,
  orderId: string,
): Promise<CashRefundDue | null> {
  return (await cashRefundDueByOrder(database, [orderId])).get(orderId) ?? null;
}
