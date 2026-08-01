/**
 * Money truth for one order, loaded once and shared by every refund creator.
 *
 * The cancellation path already computed all of this correctly; the returns path
 * computed none of it, which is why a per-return refund could re-claim the full
 * `walletAppliedPaise` on every partial return and why it had no idempotency guard
 * at all. Both now read the same basis, so "how much is left to give back, and how
 * much of it may come out of the wallet" has exactly one definition.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  orders,
  payments,
  refundDisbursements,
  refundLines,
  refunds,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type { DbOrTx } from '@/shared/refunds/rollup.js';

type PaymentRow = typeof payments.$inferSelect;

export type RefundBasis = {
  orderId: string;
  consumerId: string;
  /** Wallet applied at placement + every succeeded payment. */
  paidPaise: number;
  /** Σ of every prior refund header that has not fully failed. */
  alreadyRefundedPaise: number;
  /** What may still be handed back: max(paid − alreadyRefunded, 0). */
  refundablePaise: number;
  walletAppliedPaise: number;
  /** Σ succeeded wallet disbursements across prior refunds on this order. */
  priorWalletBackPaise: number;
  /** Wallet money not yet returned: max(walletApplied − priorWalletBack, 0). */
  walletHeadroomPaise: number;
  /** Order items already carried by a prior refund's lines — never refund them twice. */
  priorRefundedItemIds: Set<string>;
  /** Newest succeeded payment; the tender a non-wallet refund is issued against. */
  latestSucceededPayment: Pick<PaymentRow, 'id' | 'method' | 'gatewayRef'> | null;
};

export async function loadRefundBasis(dbx: DbOrTx, orderId: string): Promise<RefundBasis> {
  const order = await dbx.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, consumerId: true, walletAppliedPaise: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');

  const succeededPayments = await dbx.query.payments.findMany({
    where: and(eq(payments.orderId, orderId), eq(payments.status, 'succeeded')),
    columns: { id: true, method: true, amountPaise: true, settledAt: true, gatewayRef: true },
  });
  const paidPaise =
    order.walletAppliedPaise + succeededPayments.reduce((s, p) => s + p.amountPaise, 0);

  const priorRefunds = await dbx.query.refunds.findMany({
    where: eq(refunds.orderId, orderId),
    columns: { id: true, totalRefundPaise: true, status: true },
  });
  // A fully-failed refund returned no money, so it must not block a fresh one.
  const alreadyRefundedPaise = priorRefunds
    .filter((r) => r.status !== 'failed')
    .reduce((s, r) => s + r.totalRefundPaise, 0);

  const priorRefundIds = priorRefunds.map((r) => r.id);
  const priorLines = priorRefundIds.length
    ? await dbx.query.refundLines.findMany({
        where: inArray(refundLines.refundId, priorRefundIds),
        columns: { orderItemId: true },
      })
    : [];

  const priorWalletBackPaise = priorRefundIds.length
    ? (
        await dbx.query.refundDisbursements.findMany({
          where: and(
            inArray(refundDisbursements.refundId, priorRefundIds),
            eq(refundDisbursements.destination, 'wallet'),
            eq(refundDisbursements.status, 'succeeded'),
          ),
          columns: { amountPaise: true },
        })
      ).reduce((s, d) => s + d.amountPaise, 0)
    : 0;

  const latest = [...succeededPayments].sort(
    (a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0),
  )[0];

  return {
    orderId: order.id,
    consumerId: order.consumerId,
    paidPaise,
    alreadyRefundedPaise,
    refundablePaise: Math.max(paidPaise - alreadyRefundedPaise, 0),
    walletAppliedPaise: order.walletAppliedPaise,
    priorWalletBackPaise,
    walletHeadroomPaise: Math.max(order.walletAppliedPaise - priorWalletBackPaise, 0),
    priorRefundedItemIds: new Set(priorLines.map((l) => l.orderItemId)),
    latestSucceededPayment: latest
      ? { id: latest.id, method: latest.method, gatewayRef: latest.gatewayRef }
      : null,
  };
}

/**
 * Split a refund total across tenders: wallet money comes back to the wallet first,
 * bounded by what is left of it, and the remainder goes to the tender the consumer
 * actually paid with. Netting against `walletHeadroomPaise` (rather than the raw
 * `walletAppliedPaise`) is what stops two partial returns each re-claiming the full
 * wallet amount.
 */
export function splitRefundTenders(
  basis: RefundBasis,
  totalPaise: number,
): { walletPortion: number; originalTenderPortion: number } {
  const walletPortion = Math.min(basis.walletHeadroomPaise, totalPaise);
  return { walletPortion, originalTenderPortion: totalPaise - walletPortion };
}

/**
 * The tender a refund must be issued against. Throws when the order has no succeeded
 * payment — a non-wallet portion is only ever computed from money we actually took.
 */
export function requireSourcePayment(
  basis: RefundBasis,
): Pick<PaymentRow, 'id' | 'method' | 'gatewayRef'> {
  if (!basis.latestSucceededPayment) {
    throw new AppError(
      409,
      ErrorCode.PaymentFailed,
      'No succeeded payment found to refund the original-tender portion against',
    );
  }
  return basis.latestSucceededPayment;
}
