import { relations, sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { gatewayCaptureOrphanReason, gatewayCaptureOrphanStatus } from './enums.js';
import { adminAccounts } from './identity.js';
import { orders, payments } from './orders.js';

/**
 * Captured money with nowhere to go.
 *
 * The gateway can hand us a capture that no order can accept — the abandonment sweep
 * already cancelled and refunded the order, the consumer paid twice, the row was
 * superseded by a retry. Previously the webhook only console.error'd "recon owns it"
 * and the money sat at Razorpay until someone happened to upload a settlement file.
 *
 * Each orphan is recorded once (unique on the gateway payment id, so webhook replays
 * are free), admins are notified, and when the gateway is live the capture is refunded
 * automatically with `idempotencyKey = orphan id`.
 *
 * Deliberately NOT modelled as a `refunds` row: there is no order-level refund to
 * attach it to, and inventing one would corrupt `alreadyRefundedPaise` in the refund
 * basis and silently block a legitimate future refund.
 *
 * `payment_recon_discrepancies` cannot be reused — its `settlement_id` is NOT NULL and
 * references an uploaded settlement file that does not exist at capture time.
 */
export const gatewayCaptureOrphans = pgTable(
  'gateway_capture_orphans',
  {
    id: text('id').primaryKey(),
    gatewayOrderId: text('gateway_order_id').notNull(),
    gatewayPaymentId: text('gateway_payment_id').notNull(),
    paymentId: text('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    orderId: text('order_id').references(() => orders.id, { onDelete: 'set null' }),
    amountPaise: integer('amount_paise').notNull(),
    reason: gatewayCaptureOrphanReason('reason').notNull(),
    status: gatewayCaptureOrphanStatus('status').notNull().default('open'),
    /** The `rfnd_…` id when we managed to push the money back automatically. */
    gatewayRefundRef: text('gateway_refund_ref'),
    failureMessage: text('failure_message'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolvedByAdminId: text('resolved_by_admin_id').references(() => adminAccounts.id, {
      onDelete: 'set null',
    }),
    resolutionNote: text('resolution_note'),
  },
  (t) => ({
    // One row per captured payment — this is what makes webhook replays a no-op.
    paymentRefUniq: uniqueIndex('gateway_capture_orphans_payment_ref_uniq').on(t.gatewayPaymentId),
    openIdx: index('gateway_capture_orphans_open_idx')
      .on(t.status)
      .where(sql`${t.resolvedAt} IS NULL`),
  }),
);

export const gatewayCaptureOrphansRelations = relations(gatewayCaptureOrphans, ({ one }) => ({
  payment: one(payments, {
    fields: [gatewayCaptureOrphans.paymentId],
    references: [payments.id],
  }),
  order: one(orders, { fields: [gatewayCaptureOrphans.orderId], references: [orders.id] }),
}));
