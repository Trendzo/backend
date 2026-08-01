/**
 * The admin payout desk: how a refund leg that has no automatic rail actually gets paid.
 *
 * `manual_payout` (and an unhanded `cash`) legs are born PENDING and stay there — that
 * is the whole point of the COD fix, because the alternative is what the system used to
 * do, which was mark them complete with a fabricated reference and move no money. This
 * module is the other half of that bargain: without it, honest legs would park forever.
 *
 * Two ways to close one:
 *   settleManualPayout   — an admin paid out offline and records the reference. The
 *                          reference is MANDATORY; it is exactly what the
 *                          refund_disbursements_settled_proof_guard CHECK demands, so
 *                          an admin cannot close a leg without naming the payout.
 *   redirectToWallet     — pay it as wallet credit instead: fail the leg, chain a wallet
 *                          leg, credit the wallet. Real money, instantly, no offline step.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';
import { applyWalletDelta } from '@/shared/wallet/apply-delta.js';

/** Legs waiting on a human: manual payouts, and cash nobody has handed over yet. */
export async function listPayoutDesk(
  database: typeof Db,
  input: { destination?: 'manual_payout' | 'cash'; limit?: number } = {},
) {
  const rows = await database.query.refundDisbursements.findMany({
    where: and(
      eq(refundDisbursements.status, 'pending'),
      input.destination
        ? eq(refundDisbursements.destination, input.destination)
        : inArray(refundDisbursements.destination, ['manual_payout', 'cash']),
    ),
    orderBy: desc(refundDisbursements.initiatedAt),
    limit: input.limit ?? 100,
    with: {
      refund: {
        columns: { id: true, orderId: true, totalRefundPaise: true, status: true, reason: true },
        with: {
          order: {
            columns: {
              id: true,
              consumerId: true,
              consumerNameSnap: true,
              consumerPhoneSnap: true,
              paymentMethod: true,
              storeNameSnap: true,
            },
          },
        },
      },
    },
  });
  const now = Date.now();
  return rows.map((d) => ({
    disbursementId: d.id,
    refundId: d.refundId,
    destination: d.destination,
    amountPaise: d.amountPaise,
    initiatedAt: d.initiatedAt,
    ageHours: Math.floor((now - d.initiatedAt.getTime()) / 3_600_000),
    settlementNote: d.settlementNote,
    order: d.refund.order,
    refundReason: d.refund.reason,
  }));
}

/** Load a pending desk leg, or explain precisely why it cannot be settled. */
async function loadPendingLeg(database: typeof Db, disbursementId: string) {
  const d = await database.query.refundDisbursements.findFirst({
    where: eq(refundDisbursements.id, disbursementId),
    with: { refund: { with: { order: { columns: { id: true, consumerId: true } } } } },
  });
  if (!d) throw new AppError(404, ErrorCode.DisbursementNotFound, 'Disbursement not found');
  if (d.status !== 'pending') {
    throw new AppError(
      409,
      ErrorCode.DisbursementAlreadyTerminal,
      `Disbursement is '${d.status}' — only a pending one can be settled from the desk`,
    );
  }
  if (d.destination !== 'manual_payout' && d.destination !== 'cash') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `A '${d.destination}' disbursement is settled by its own rail, not the payout desk`,
    );
  }
  return d;
}

export async function settleManualPayout(
  database: typeof Db,
  input: { disbursementId: string; reference: string; note?: string; adminId: string },
): Promise<{ disbursementId: string; refundId: string; refundStatus: string }> {
  const d = await loadPendingLeg(database, input.disbursementId);

  const refundStatus = await database.transaction(async (tx) => {
    const [settled] = await tx
      .update(refundDisbursements)
      .set({
        status: 'succeeded',
        gatewayRef: `MANUAL-${input.reference}`,
        settledAt: new Date(),
        settledByActorType: 'admin',
        settledByActorId: input.adminId,
        settlementNote: input.note ?? null,
      })
      .where(
        and(
          eq(refundDisbursements.id, input.disbursementId),
          eq(refundDisbursements.status, 'pending'),
        ),
      )
      .returning({ id: refundDisbursements.id });
    // Zero rows = someone else settled it between the load and here.
    if (!settled) {
      throw new AppError(
        409,
        ErrorCode.DisbursementAlreadyTerminal,
        'Disbursement was settled by someone else',
      );
    }
    return rollUpRefundStatus(tx, d.refundId);
  });

  await notifyConsumer({
    consumerId: d.refund.order.consumerId,
    kind: 'refund',
    title: 'Refund paid out',
    body: `₹${(d.amountPaise / 100).toFixed(2)} has been sent to you (reference ${input.reference}).`,
    deepLink: `/orders/${d.refund.orderId}`,
    payload: { refundId: d.refundId, disbursementId: d.id },
  }).catch(() => undefined);

  return { disbursementId: d.id, refundId: d.refundId, refundStatus };
}

/**
 * Pay a stuck leg as wallet credit instead. The pending leg is failed and a wallet leg
 * is chained onto it via `previousDisbursementId`, so the roll-up counts only the
 * successor — the same chain shape force-fail/retry already use. `sourcePaymentId` is
 * null on the new leg, which is what the destination CHECK requires for wallet.
 */
export async function redirectPayoutToWallet(
  database: typeof Db,
  input: { disbursementId: string; note?: string; adminId: string },
): Promise<{ disbursementId: string; walletDisbursementId: string; refundStatus: string }> {
  const d = await loadPendingLeg(database, input.disbursementId);
  const walletDisbId = newId(IdPrefix.RefundDisbursement);

  const refundStatus = await database.transaction(async (tx) => {
    const [failed] = await tx
      .update(refundDisbursements)
      .set({
        status: 'failed',
        settledAt: new Date(),
        settledByActorType: 'admin',
        settledByActorId: input.adminId,
        settlementNote: input.note ?? 'Redirected to wallet credit',
      })
      .where(
        and(
          eq(refundDisbursements.id, input.disbursementId),
          eq(refundDisbursements.status, 'pending'),
        ),
      )
      .returning({ id: refundDisbursements.id });
    if (!failed) {
      throw new AppError(
        409,
        ErrorCode.DisbursementAlreadyTerminal,
        'Disbursement was settled by someone else',
      );
    }

    await applyWalletDelta(tx, {
      consumerId: d.refund.order.consumerId,
      deltaPaise: d.amountPaise,
      kind: 'refund_credit',
      refOrderId: d.refund.orderId,
      refRefundId: d.refundId,
      note: `Refund redirected to wallet (disbursement ${d.id})`,
    });

    await tx.insert(refundDisbursements).values({
      id: walletDisbId,
      refundId: d.refundId,
      destination: 'wallet',
      sourcePaymentId: null,
      amountPaise: d.amountPaise,
      status: 'succeeded',
      gatewayRef: null,
      settledAt: new Date(),
      previousDisbursementId: d.id,
      settledByActorType: 'admin',
      settledByActorId: input.adminId,
    });

    return rollUpRefundStatus(tx, d.refundId);
  });

  await notifyConsumer({
    consumerId: d.refund.order.consumerId,
    kind: 'refund',
    title: 'Refund added to your wallet',
    body: `₹${(d.amountPaise / 100).toFixed(2)} is now in your ClosetX wallet.`,
    deepLink: `/orders/${d.refund.orderId}`,
    payload: { refundId: d.refundId, disbursementId: walletDisbId },
  }).catch(() => undefined);

  return { disbursementId: d.id, walletDisbursementId: walletDisbId, refundStatus };
}
