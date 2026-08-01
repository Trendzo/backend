/**
 * Settle a refund disbursement that is not a wallet credit.
 *
 * The rail was already chosen when the row was written (`resolveTenderDestination`),
 * so this function only executes it. That inversion is the fix for the COD bug: there
 * is no longer a fall-through branch that fabricates a success for anything the
 * gateway cannot handle.
 *
 *   original_tender — real Razorpay refund, or the dev/test simulation of one
 *   manual_payout   — left PENDING on the admin payout desk. Never auto-completed.
 *   cash / wallet   — not settled here; reaching this function with one is a bug
 *
 * Call AFTER the refund tx commits (network out of the transaction); the disbursement
 * row must exist in 'pending'.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { getGateway } from '@/shared/payments/gateway.js';
import { isRazorpayActive, isRazorpayPaymentRef } from '@/shared/payments/razorpay.js';
import { assertNoSimulatedMoney } from '@/shared/payments/simulation-guard.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';

export type TenderSettleOutcome = 'succeeded' | 'failed' | 'pending';

export async function settleTenderDisbursement(
  database: typeof Db,
  input: {
    refundId: string;
    disbursementId: string;
    amountPaise: number;
    sourceGatewayRef: string | null;
    /** Defaults to the historical rail so existing callers keep working. */
    destination?: 'original_tender' | 'manual_payout' | 'cash' | 'wallet';
  },
): Promise<TenderSettleOutcome> {
  const destination = input.destination ?? 'original_tender';

  if (destination === 'wallet' || destination === 'cash') {
    throw new AppError(
      500,
      ErrorCode.InternalError,
      `A '${destination}' disbursement is settled by its own path, not by the tender settler`,
    );
  }

  if (destination === 'manual_payout') {
    // Deliberately touches nothing: the leg stays 'pending' until a human moves real
    // money and records the reference. This is the branch that used to lie.
    await rollUpRefundStatus(database, input.refundId);
    await notifyAllAdmins({
      kind: 'system',
      title: 'Manual payout needed',
      body: `Refund ${input.refundId}: ₹${(input.amountPaise / 100).toFixed(2)} has no automatic rail and is waiting on the payout desk.`,
      deepLink: '/admin/refunds/payout-desk',
      payload: { refundId: input.refundId, disbursementId: input.disbursementId },
    }).catch(() => undefined);
    return 'pending';
  }

  if (isRazorpayActive() && isRazorpayPaymentRef(input.sourceGatewayRef)) {
    const result = await getGateway().refund({
      disbursementId: input.disbursementId,
      sourceGatewayRef: input.sourceGatewayRef!,
      amountPaise: input.amountPaise,
      idempotencyKey: input.disbursementId,
    });
    if (result.status === 'succeeded') {
      await database
        .update(refundDisbursements)
        .set({ status: 'succeeded', gatewayRef: result.gatewayRef, settledAt: result.settledAt })
        .where(eq(refundDisbursements.id, input.disbursementId));
      await rollUpRefundStatus(database, input.refundId);
      return 'succeeded';
    }
    await database
      .update(refundDisbursements)
      .set({ status: 'failed' })
      .where(eq(refundDisbursements.id, input.disbursementId));
    await rollUpRefundStatus(database, input.refundId);
    await notifyAllAdmins({
      kind: 'system',
      title: 'Gateway refund failed — needs retry',
      body: `Refund ${input.refundId}: ${result.failureMessage}`,
      payload: { refundId: input.refundId, disbursementId: input.disbursementId },
    }).catch(() => undefined);
    return 'failed';
  }

  // Simulated path — mock gateway or a legacy simulated source ref. Unreachable in
  // production by construction (rule 6 of resolveTenderDestination re-routes it to
  // manual_payout), so this is the hard backstop rather than the primary guard.
  assertNoSimulatedMoney(
    `refund ${input.refundId} disbursement ${input.disbursementId} (source ref ${input.sourceGatewayRef ?? 'none'})`,
  );
  await database
    .update(refundDisbursements)
    .set({
      status: 'succeeded',
      gatewayRef: `REFUND-TEST-${input.disbursementId.slice(4, 16)}`,
      settledAt: new Date(),
    })
    .where(eq(refundDisbursements.id, input.disbursementId));
  await rollUpRefundStatus(database, input.refundId);
  return 'succeeded';
}
