import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import {
  refundDisbursementDestination,
  refundDisbursementStatus,
  refundStatus,
} from './enums.js';
import { orderItems, orders, payments } from './orders.js';

/**
 * Three-table refund split. Cardinality the spec demands:
 *   refund 1 — N refund_line     (one line per returned order_item)
 *   refund 1 — N refund_disbursement (one per destination tender — wallet, original UPI, etc.)
 *
 * `refund.status` is rolled up from the disbursements: succeeded if all succeed,
 * partially_disbursed if some succeed and some still pending, failed if all final-fail.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    totalRefundPaise: integer('total_refund_paise').notNull(),
    status: refundStatus('status').notNull().default('pending'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    orderIdx: index('refunds_order_idx').on(t.orderId),
    statusIdx: index('refunds_status_idx').on(t.status),
  }),
);

/**
 * Per-item allocation. Captures how much of the parent refund pertains to each returned
 * order_item, including the slice of order-level coupon/points that gets clawed back.
 */
export const refundLines = pgTable(
  'refund_lines',
  {
    id: text('id').primaryKey(),
    refundId: text('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    orderItemId: text('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    refundedAmountPaise: integer('refunded_amount_paise').notNull(),
    couponClawbackPaise: integer('coupon_clawback_paise').notNull().default(0),
    pointsClawbackPaise: integer('points_clawback_paise').notNull().default(0),
    taxRefundPaise: integer('tax_refund_paise').notNull().default(0),
  },
  (t) => ({
    refundIdx: index('refund_lines_refund_idx').on(t.refundId),
    orderItemIdx: index('refund_lines_order_item_idx').on(t.orderItemId),
  }),
);

/**
 * One row per outbound transfer (wallet credit or gateway refund). Mixed-tender refunds
 * proportionally split across each tender used at checkout. `previousDisbursementId`
 * chains retries on gateway failure, mirroring the payment retry pattern.
 */
export const refundDisbursements = pgTable(
  'refund_disbursements',
  {
    id: text('id').primaryKey(),
    refundId: text('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    destination: refundDisbursementDestination('destination').notNull(),
    sourcePaymentId: text('source_payment_id').references(() => payments.id),
    amountPaise: integer('amount_paise').notNull(),
    status: refundDisbursementStatus('status').notNull().default('pending'),
    gatewayRef: text('gateway_ref'),
    previousDisbursementId: text('previous_disbursement_id'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    refundStatusIdx: index('refund_disbursements_refund_status_idx').on(t.refundId, t.status),
    previousDisbursementFk: foreignKey({
      columns: [t.previousDisbursementId],
      foreignColumns: [t.id],
      name: 'refund_disbursements_previous_disbursement_id_fk',
    }),
    // Wallet refunds have no source payment; original-tender refunds must point to one.
    destinationGuard: check(
      'refund_disbursements_destination_guard',
      sql`(${t.destination} = 'wallet' AND ${t.sourcePaymentId} IS NULL)
        OR (${t.destination} = 'original_tender' AND ${t.sourcePaymentId} IS NOT NULL)`,
    ),
  }),
);

// ===== Relations =====

export const refundsRelations = relations(refunds, ({ one, many }) => ({
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  lines: many(refundLines),
  disbursements: many(refundDisbursements),
}));

export const refundLinesRelations = relations(refundLines, ({ one }) => ({
  refund: one(refunds, { fields: [refundLines.refundId], references: [refunds.id] }),
  orderItem: one(orderItems, {
    fields: [refundLines.orderItemId],
    references: [orderItems.id],
  }),
}));

export const refundDisbursementsRelations = relations(refundDisbursements, ({ one }) => ({
  refund: one(refunds, { fields: [refundDisbursements.refundId], references: [refunds.id] }),
  sourcePayment: one(payments, {
    fields: [refundDisbursements.sourcePaymentId],
    references: [payments.id],
  }),
  previousDisbursement: one(refundDisbursements, {
    fields: [refundDisbursements.previousDisbursementId],
    references: [refundDisbursements.id],
    relationName: 'refundRetryChain',
  }),
}));
