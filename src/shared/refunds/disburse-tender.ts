/**
 * Settle an original-tender refund disbursement. Two worlds, one call:
 *   - Razorpay active + the source payment is a real capture (`pay_…`): hit the
 *     refund API. Success → row succeeded with the `rfnd_…` id; failure → row
 *     'failed' + refund left 'partially_disbursed' + admins notified (the
 *     force-fail → retry desk owns it from there).
 *   - Otherwise (mock gateway / legacy simulated refs): simulated success with a
 *     `REFUND-TEST-…` ref — identical to the historical behaviour, so tests and
 *     dev environments stay network-free.
 *
 * Call AFTER the refund tx commits (network out of the transaction); the
 * disbursement row must exist in 'pending'.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements, refunds } from '@/db/schema/index.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { getGateway } from '@/shared/payments/gateway.js';
import { isRazorpayActive, isRazorpayPaymentRef } from '@/shared/payments/razorpay.js';

export async function settleTenderDisbursement(
  database: typeof Db,
  input: {
    refundId: string;
    disbursementId: string;
    amountPaise: number;
    sourceGatewayRef: string | null;
  },
): Promise<'succeeded' | 'failed'> {
  const useGateway = isRazorpayActive() && isRazorpayPaymentRef(input.sourceGatewayRef);

  if (useGateway) {
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
      await database
        .update(refunds)
        .set({ status: 'succeeded', completedAt: new Date() })
        .where(eq(refunds.id, input.refundId));
      return 'succeeded';
    }
    await database
      .update(refundDisbursements)
      .set({ status: 'failed' })
      .where(eq(refundDisbursements.id, input.disbursementId));
    await database
      .update(refunds)
      .set({ status: 'partially_disbursed' })
      .where(eq(refunds.id, input.refundId));
    await notifyAllAdmins({
      kind: 'system',
      title: 'Gateway refund failed — needs retry',
      body: `Refund ${input.refundId}: ${result.failureMessage}`,
      payload: { refundId: input.refundId, disbursementId: input.disbursementId },
    }).catch(() => undefined);
    return 'failed';
  }

  // Simulated path (mock gateway or non-gateway source ref).
  await database
    .update(refundDisbursements)
    .set({
      status: 'succeeded',
      gatewayRef: `REFUND-TEST-${input.disbursementId.slice(4, 16)}`,
      settledAt: new Date(),
    })
    .where(eq(refundDisbursements.id, input.disbursementId));
  await database
    .update(refunds)
    .set({ status: 'succeeded', completedAt: new Date() })
    .where(eq(refunds.id, input.refundId));
  return 'succeeded';
}
