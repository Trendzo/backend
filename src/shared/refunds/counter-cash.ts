/**
 * Cash handed across the store counter for a COD refund.
 *
 * The mirror image of the driver channel. At a counter return the customer is standing
 * there, so the return is verified FIRST and the refund's cash leg is born `pending`;
 * this records the notes actually going across and closes the leg.
 *
 * Exactly-once is the CAS on `status='pending'` — a replayed request finds no row and
 * 409s rather than paying twice.
 *
 * The store just paid out platform money, so a matching payout-adjustment CREDIT is
 * written and the next settlement cycle repays it. Without that the retailer is simply
 * out of pocket. (The wider pre-existing gap — that COD cash never nets against store
 * payouts at all — is untouched here.)
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  refundCashHandovers,
  refundDisbursements,
  refundLines,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';

export async function settleCashAtCounter(
  database: typeof Db,
  input: {
    disbursementId: string;
    amountPaise: number;
    note?: string;
    storeId: string;
    actorId: string;
  },
): Promise<{ disbursementId: string; handoverId: string; refundStatus: string }> {
  const d = await database.query.refundDisbursements.findFirst({
    where: eq(refundDisbursements.id, input.disbursementId),
    with: {
      refund: {
        with: { order: { columns: { id: true, storeId: true, consumerId: true } } },
      },
    },
  });
  if (!d) throw new AppError(404, ErrorCode.DisbursementNotFound, 'Disbursement not found');
  if (d.refund.order.storeId !== input.storeId) {
    throw new AppError(403, ErrorCode.Forbidden, 'Refund does not belong to your store');
  }
  if (d.destination !== 'cash') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `This refund is paid by ${d.destination}, not cash at the counter`,
    );
  }
  if (d.status !== 'pending') {
    throw new AppError(
      409,
      ErrorCode.DisbursementAlreadyTerminal,
      `Disbursement is already '${d.status}'`,
    );
  }
  // No partial counter payments: the customer either gets the amount or they don't.
  if (input.amountPaise !== d.amountPaise) {
    throw AppError.validation(
      `Hand ₹${(d.amountPaise / 100).toFixed(2)} in cash — the amount must match exactly`,
    );
  }

  // Which returns this refund covers, so the handover records what the cash was for.
  const lines = await database.query.refundLines.findMany({
    where: eq(refundLines.refundId, d.refundId),
    columns: { orderItemId: true },
  });
  const coveredReturnIds = lines.length
    ? (
        await database.query.returns.findMany({
          where: inArray(
            returns.orderItemId,
            lines.map((l) => l.orderItemId),
          ),
          columns: { id: true },
        })
      ).map((r) => r.id)
    : [];

  const handoverId = newId(IdPrefix.RefundCashHandover);
  const now = new Date();

  const refundStatus = await database.transaction(async (tx) => {
    await tx.insert(refundCashHandovers).values({
      id: handoverId,
      orderId: d.refund.orderId,
      returnIds: coveredReturnIds,
      amountPaise: input.amountPaise,
      channel: 'store_counter',
      storeId: input.storeId,
      recordedByActorType: 'retailer',
      recordedByActorId: input.actorId,
      note: input.note ?? null,
      handedAt: now,
    });

    const [settled] = await tx
      .update(refundDisbursements)
      .set({
        status: 'succeeded',
        settledAt: now,
        gatewayRef: `CASH-${handoverId.slice(4, 16)}`,
        cashHandoverId: handoverId,
        settledByActorType: 'retailer',
        settledByActorId: input.actorId,
        settlementNote: input.note ?? null,
      })
      .where(
        and(
          eq(refundDisbursements.id, input.disbursementId),
          eq(refundDisbursements.status, 'pending'),
        ),
      )
      .returning({ id: refundDisbursements.id });
    if (!settled) {
      throw new AppError(
        409,
        ErrorCode.DisbursementAlreadyTerminal,
        'Disbursement was settled by someone else',
      );
    }

    return rollUpRefundStatus(tx, d.refundId);
  });

  // Repay the store out of the next payout cycle — they fronted platform money.
  try {
    const { recordAdjustment } = await import('@/shared/settlement/adjustments.js');
    await recordAdjustment({
      storeId: input.storeId,
      direction: 'credit',
      amountPaise: input.amountPaise,
      reason: `Cash refund paid at counter for refund ${d.refundId}`,
      adminId: 'system',
      kind: 'manual',
    });
  } catch (err) {
    console.error(
      `[counter-cash] payout adjustment failed for refund ${d.refundId}: ${(err as Error).message}`,
    );
  }

  await notifyConsumer({
    consumerId: d.refund.order.consumerId,
    kind: 'refund',
    title: 'Refund paid in cash',
    body: `₹${(input.amountPaise / 100).toFixed(2)} was handed to you at the store counter.`,
    deepLink: `/orders/${d.refund.orderId}`,
    payload: { refundId: d.refundId, disbursementId: d.id },
  }).catch(() => undefined);

  return { disbursementId: d.id, handoverId, refundStatus };
}
