/**
 * §15 Payment Capture — settlement reconciliation tables.
 *
 * Design goal: gateway-agnostic. Each settlement file (CSV/JSON) maps to a
 * `payment_settlements` header row + N `payment_settlement_entries` line items.
 * Reconciliation matches entries against `payments.gateway_ref`; mismatches become
 * `payment_recon_discrepancies` rows for ops-admin triage. When real PG arrives,
 * only the file-parsing adapter changes — the table shapes stay constant.
 */
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { paymentReconDiscrepancyKind, paymentSettlementEntryMatchStatus, paymentSettlementStatus } from './enums.js';
import { payments } from './orders.js';

/**
 * One row per uploaded settlement file. `gatewayName` and `fileRef` are pure metadata
 * — the parser is selected per-gateway by code, not by row contents.
 */
export const paymentSettlements = pgTable(
  'payment_settlements',
  {
    id: text('id').primaryKey(),
    gatewayName: text('gateway_name').notNull(), // 'razorpay' | 'stripe' | 'mock' …
    cycleStart: timestamp('cycle_start', { withTimezone: true, mode: 'date' }).notNull(),
    cycleEnd: timestamp('cycle_end', { withTimezone: true, mode: 'date' }).notNull(),
    fileRef: text('file_ref'), // s3 key or filename (informational)
    uploadedByAdminId: text('uploaded_by_admin_id').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: paymentSettlementStatus('status').notNull().default('uploaded'),
    /**
     * Aggregate counters after reconciliation:
     *   { totalEntries, matched, amountMismatch, missingInCapture, missingInSettlement,
     *     duplicate, totalAmountPaise }
     */
    summary: jsonb('summary').$type<Record<string, number>>().notNull().default({}),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    cycleIdx: index('payment_settlements_cycle_idx').on(t.cycleStart, t.cycleEnd),
    statusIdx: index('payment_settlements_status_idx').on(t.status),
    cycleWindowGuard: check(
      'payment_settlements_cycle_window_guard',
      sql`${t.cycleEnd} > ${t.cycleStart}`,
    ),
  }),
);

/**
 * Individual line item from a settlement file. `matchedPaymentId` is non-null only
 * after reconciliation. `matchStatus` records the outcome of the match attempt.
 */
export const paymentSettlementEntries = pgTable(
  'payment_settlement_entries',
  {
    id: text('id').primaryKey(),
    settlementId: text('settlement_id')
      .notNull()
      .references(() => paymentSettlements.id, { onDelete: 'cascade' }),
    gatewayRef: text('gateway_ref').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    txAt: timestamp('tx_at', { withTimezone: true, mode: 'date' }).notNull(),
    matchedPaymentId: text('matched_payment_id').references(() => payments.id),
    matchStatus: paymentSettlementEntryMatchStatus('match_status').notNull().default('pending'),
    /** Extra fields the gateway provided we don't structurally model yet. */
    raw: jsonb('raw'),
  },
  (t) => ({
    settlementIdx: index('payment_settlement_entries_settlement_idx').on(t.settlementId),
    gatewayRefIdx: index('payment_settlement_entries_gateway_ref_idx').on(t.gatewayRef),
    // A single settlement file should not list the same gateway_ref twice. If it does,
    // it's a duplicate we want to flag — enforced as a uniqueness constraint, broken
    // ties surface as `duplicate` discrepancies on the OTHER end of the reconciler.
    uniqueRefPerSettlement: uniqueIndex('payment_settlement_entries_unique_ref').on(
      t.settlementId,
      t.gatewayRef,
    ),
  }),
);

/**
 * One row per anomaly surfaced by reconciliation. Soft-resolved via `resolvedAt`;
 * history kept for audit.
 *
 *   kind=amount_mismatch  → entry + payment match by gateway_ref, amounts differ
 *   kind=missing_in_capture → settlement has a ref our payments table doesn't
 *   kind=missing_in_settlement → succeeded payment in cycle absent from file
 *   kind=status_mismatch  → entry says succeeded but our payment is failed (or vice versa)
 *   kind=duplicate        → same gateway_ref appears multiple times across files
 */
export const paymentReconDiscrepancies = pgTable(
  'payment_recon_discrepancies',
  {
    id: text('id').primaryKey(),
    settlementId: text('settlement_id')
      .notNull()
      .references(() => paymentSettlements.id, { onDelete: 'cascade' }),
    paymentId: text('payment_id').references(() => payments.id),
    entryId: text('entry_id').references(() => paymentSettlementEntries.id, { onDelete: 'cascade' }),
    kind: paymentReconDiscrepancyKind('kind').notNull(),
    /** Free-form payload of mismatched fields for UI display. */
    details: jsonb('details').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    resolvedByAdminId: text('resolved_by_admin_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolvedNote: text('resolved_note'),
  },
  (t) => ({
    settlementIdx: index('payment_recon_discrepancies_settlement_idx').on(t.settlementId),
    openIdx: index('payment_recon_discrepancies_open_idx')
      .on(t.settlementId)
      .where(sql`${t.resolvedAt} IS NULL`),
  }),
);

// ===== Relations =====

export const paymentSettlementsRelations = relations(paymentSettlements, ({ many }) => ({
  entries: many(paymentSettlementEntries),
  discrepancies: many(paymentReconDiscrepancies),
}));

export const paymentSettlementEntriesRelations = relations(
  paymentSettlementEntries,
  ({ one }) => ({
    settlement: one(paymentSettlements, {
      fields: [paymentSettlementEntries.settlementId],
      references: [paymentSettlements.id],
    }),
    matchedPayment: one(payments, {
      fields: [paymentSettlementEntries.matchedPaymentId],
      references: [payments.id],
    }),
  }),
);

export const paymentReconDiscrepanciesRelations = relations(
  paymentReconDiscrepancies,
  ({ one }) => ({
    settlement: one(paymentSettlements, {
      fields: [paymentReconDiscrepancies.settlementId],
      references: [paymentSettlements.id],
    }),
    payment: one(payments, {
      fields: [paymentReconDiscrepancies.paymentId],
      references: [payments.id],
    }),
    entry: one(paymentSettlementEntries, {
      fields: [paymentReconDiscrepancies.entryId],
      references: [paymentSettlementEntries.id],
    }),
  }),
);
