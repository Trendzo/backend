/**
 * Record — and where possible automatically refund — a captured payment that no order
 * can accept.
 *
 * The gateway can hand us a capture with nowhere to go: the abandonment sweep already
 * cancelled and refunded the order, the consumer paid twice, the row was superseded by
 * a retry. The old handler only `console.error`'d "recon owns it", so the money sat at
 * Razorpay until somebody happened to upload a settlement file.
 *
 * Deliberately NOT modelled as a `refunds` row: there is no order-level refund to
 * attach it to, and inventing one would corrupt `alreadyRefundedPaise` in the refund
 * basis and silently block a legitimate future refund on that order.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { gatewayCaptureOrphans } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { getGateway } from '@/shared/payments/gateway.js';
import { isRazorpayActive } from '@/shared/payments/razorpay.js';

export type OrphanReason =
  | 'already_paid'
  | 'order_not_awaiting_payment'
  | 'duplicate_capture'
  | 'superseded_attempt'
  | 'order_terminal';

const REASON_TEXT: Record<OrphanReason, string> = {
  already_paid: 'the order was already paid by another attempt',
  order_not_awaiting_payment: 'the order is no longer awaiting payment',
  duplicate_capture: 'a different capture is already recorded against this payment row',
  superseded_attempt: 'this payment attempt was superseded by a retry',
  order_terminal: 'the order had already reached a terminal state',
};

export async function recordOrphanCapture(
  database: typeof Db,
  input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    paymentId?: string | null;
    orderId?: string | null;
    amountPaise: number;
    reason: OrphanReason;
  },
): Promise<{ orphanId: string; created: boolean }> {
  const id = newId(IdPrefix.GatewayCaptureOrphan);
  // The unique index on gateway_payment_id is what makes webhook replays free.
  const [inserted] = await database
    .insert(gatewayCaptureOrphans)
    .values({
      id,
      gatewayOrderId: input.gatewayOrderId,
      gatewayPaymentId: input.gatewayPaymentId,
      paymentId: input.paymentId ?? null,
      orderId: input.orderId ?? null,
      amountPaise: input.amountPaise,
      reason: input.reason,
    })
    .onConflictDoNothing({ target: gatewayCaptureOrphans.gatewayPaymentId })
    .returning({ id: gatewayCaptureOrphans.id });

  if (!inserted) {
    const existing = await database.query.gatewayCaptureOrphans.findFirst({
      where: eq(gatewayCaptureOrphans.gatewayPaymentId, input.gatewayPaymentId),
      columns: { id: true },
    });
    return { orphanId: existing?.id ?? id, created: false };
  }

  await notifyAllAdmins({
    kind: 'system',
    title: 'Captured payment with nowhere to go',
    body: `₹${(input.amountPaise / 100).toFixed(2)} captured as ${input.gatewayPaymentId} — ${REASON_TEXT[input.reason]}.`,
    deepLink: '/admin/payment-reconciliation',
    payload: {
      orphanId: inserted.id,
      gatewayOrderId: input.gatewayOrderId,
      gatewayPaymentId: input.gatewayPaymentId,
      orderId: input.orderId ?? null,
    },
  }).catch(() => undefined);

  await attemptOrphanRefund(database, inserted.id);
  return { orphanId: inserted.id, created: true };
}

/**
 * Push the money back through the gateway. Only ever attempted against a real
 * gateway — a mock/inactive gateway leaves the row `open` for the admin desk rather
 * than stamping a fake reference on real money.
 */
export async function attemptOrphanRefund(
  database: typeof Db,
  orphanId: string,
): Promise<'refunded' | 'refund_failed' | 'open'> {
  const row = await database.query.gatewayCaptureOrphans.findFirst({
    where: eq(gatewayCaptureOrphans.id, orphanId),
  });
  if (!row || row.resolvedAt) return 'open';
  if (!isRazorpayActive()) return 'open';

  await database
    .update(gatewayCaptureOrphans)
    .set({
      status: 'refund_initiated',
      attempts: row.attempts + 1,
      lastAttemptAt: new Date(),
    })
    .where(eq(gatewayCaptureOrphans.id, orphanId));

  const result = await getGateway().refund({
    disbursementId: orphanId,
    sourceGatewayRef: row.gatewayPaymentId,
    amountPaise: row.amountPaise,
    idempotencyKey: orphanId,
  });

  if (result.status === 'succeeded') {
    await database
      .update(gatewayCaptureOrphans)
      .set({
        status: 'refunded',
        gatewayRefundRef: result.gatewayRef,
        resolvedAt: new Date(),
        failureMessage: null,
      })
      .where(eq(gatewayCaptureOrphans.id, orphanId));
    return 'refunded';
  }

  await database
    .update(gatewayCaptureOrphans)
    .set({ status: 'refund_failed', failureMessage: result.failureMessage ?? null })
    .where(eq(gatewayCaptureOrphans.id, orphanId));
  return 'refund_failed';
}
