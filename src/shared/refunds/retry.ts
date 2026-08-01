/**
 * Admin retry of a pending disbursement (created by force-fail or manual).
 * Wallet legs credit immediately; original-tender legs go through the active
 * gateway (real Razorpay refund when configured, simulated otherwise).
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { payments, refundDisbursements } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { settleTenderDisbursement } from '@/shared/refunds/disburse-tender.js';
import { rollUpRefundStatus } from '@/shared/refunds/rollup.js';
import { applyWalletDelta } from '@/shared/wallet/apply-delta.js';
import type { ActorType } from '@/shared/orders/state-machine.js';

export async function retryDisbursement(
  database: typeof Db,
  input: {
    disbursementId: string;
    actor: { type: ActorType; id: string };
  },
): Promise<{ disbursementId: string; refundId: string; outcome: 'succeeded' }> {
  const d = await database.query.refundDisbursements.findFirst({
    where: eq(refundDisbursements.id, input.disbursementId),
    with: { refund: { with: { order: true } } },
  });
  if (!d) throw new AppError(404, ErrorCode.DisbursementNotFound, 'Disbursement not found');
  if (d.status !== 'pending') {
    throw new AppError(
      409,
      ErrorCode.DisbursementAlreadyTerminal,
      `Cannot retry disbursement in '${d.status}' status`,
    );
  }

  await database.transaction(async (tx) => {
    if (d.destination === 'wallet') {
      await applyWalletDelta(tx, {
        consumerId: d.refund.order.consumerId,
        deltaPaise: d.amountPaise,
        kind: 'refund_credit',
        refOrderId: d.refund.orderId,
        refRefundId: d.refundId,
        note: `Refund retry ${d.id}`,
      });
      await tx
        .update(refundDisbursements)
        .set({ status: 'succeeded', settledAt: new Date() })
        .where(eq(refundDisbursements.id, input.disbursementId));
    }

    // Roll up over the leaf disbursements, which now sees the flip above.
    // (Tender legs settle post-tx via the gateway; their own settle re-rolls-up.)
    await rollUpRefundStatus(tx, d.refundId);
  });

  // Original-tender leg: real gateway refund when active (simulated otherwise).
  if (d.destination === 'original_tender') {
    const source = d.sourcePaymentId
      ? await database.query.payments.findFirst({
          where: eq(payments.id, d.sourcePaymentId),
          columns: { gatewayRef: true },
        })
      : null;
    const outcome = await settleTenderDisbursement(database, {
      refundId: d.refundId,
      disbursementId: d.id,
      amountPaise: d.amountPaise,
      sourceGatewayRef: source?.gatewayRef ?? null,
    });
    if (outcome === 'failed') {
      throw new AppError(502, ErrorCode.PaymentFailed, 'Gateway refund failed — see admin alerts');
    }
  }

  return { disbursementId: input.disbursementId, refundId: d.refundId, outcome: 'succeeded' };
}
