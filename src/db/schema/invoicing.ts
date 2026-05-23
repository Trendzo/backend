import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  billingStatementStatus,
  earlyDisbursementStatus,
  gstReturnKind,
  gstReturnStatus,
  invoiceKind,
  invoiceResetCycle,
  invoiceStatus,
  payoutAdjustmentDirection,
  payoutAdjustmentKind,
  payoutHoldStatus,
  payoutStatus,
  postPayoutRecoveryStatus,
  taxSplitKind,
} from './enums.js';
import { bankAccounts, retailerStores } from './store.js';
import { orders } from './orders.js';
import { refunds } from './refunds.js';

/**
 * Tax invoices and bills of supply. Numbering is per-(legal_entity, FY, series) — sequence
 * counter lives in `invoiceSequenceCounters`. The composite uniqueness on
 * (legal_entity_id, fiscal_year, series, sequence_no) is the source of truth that the
 * counter feeds; never derive the human-readable invoice number from anything else.
 *
 * PII LEGAL HOLD: consumer_*_snap fields here are exempt from the order PII scrub.
 * Indian GST rules require invoices be reproducible as-issued for ~8 years.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    kind: invoiceKind('kind').notNull(),
    legalEntityId: text('legal_entity_id').notNull(),
    fiscalYear: text('fiscal_year').notNull(), // "2026-27"
    series: text('series').notNull(), // e.g. "TAX-A", "BOS-A"
    sequenceNo: integer('sequence_no').notNull(),
    invoiceNumber: text('invoice_number').notNull(), // human-readable composed value

    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),

    // PII LEGAL HOLD — never scrubbed (Order *_snap is scrubbed; Invoice is exempt)
    consumerNameSnap: text('consumer_name_snap').notNull(),
    consumerBillingAddressSnap: text('consumer_billing_address_snap').notNull(),
    consumerGstinSnap: text('consumer_gstin_snap'), // B2B only
    storeLegalNameSnap: text('store_legal_name_snap').notNull(),
    storeAddressSnap: text('store_address_snap').notNull(),
    storeGstinSnap: text('store_gstin_snap').notNull(),
    storeStateCodeSnap: text('store_state_code_snap').notNull(),

    // Totals (paise)
    subtotalPaise: integer('subtotal_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    taxableValuePaise: integer('taxable_value_paise').notNull(),
    taxSplitKind: taxSplitKind('tax_split_kind').notNull(),
    cgstPaise: integer('cgst_paise').notNull().default(0),
    sgstPaise: integer('sgst_paise').notNull().default(0),
    igstPaise: integer('igst_paise').notNull().default(0),
    tcsPaise: integer('tcs_paise').notNull().default(0),
    // Mirrors orders.tcs_rate_bp_snap so the invoice is reproducible after platform_config
    // tcs_rate_bp is edited. Read from the order at invoice issuance, never live config.
    // Default exists for migration backfill only.
    tcsRateBpSnap: integer('tcs_rate_bp_snap').notNull().default(100),
    grandTotalPaise: integer('grand_total_paise').notNull(),

    pdfUrl: text('pdf_url'),
    status: invoiceStatus('status').notNull().default('draft'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    seqUniqueIdx: uniqueIndex('invoices_seq_unique_idx').on(
      t.legalEntityId,
      t.fiscalYear,
      t.series,
      t.sequenceNo,
    ),
    orderIdx: index('invoices_order_idx').on(t.orderId),
    storeIdx: index('invoices_store_idx').on(t.storeId),
    // GST split must match jurisdiction — same invariant as orders.
    gstSplitGuard: check(
      'invoices_gst_split_guard',
      sql`(${t.taxSplitKind} = 'intra_state'
            AND ${t.igstPaise} = 0
            AND ${t.cgstPaise} + ${t.sgstPaise} + ${t.taxableValuePaise} >= 0
            AND ${t.cgstPaise} + ${t.sgstPaise} = ${t.grandTotalPaise} - ${t.subtotalPaise} + ${t.discountPaise} - ${t.tcsPaise})
        OR (${t.taxSplitKind} = 'inter_state'
            AND ${t.cgstPaise} = 0
            AND ${t.sgstPaise} = 0
            AND ${t.igstPaise} = ${t.grandTotalPaise} - ${t.subtotalPaise} + ${t.discountPaise} - ${t.tcsPaise})`,
    ),
  }),
);

/**
 * Counter for invoice numbering. Read with SELECT FOR UPDATE inside the issuance txn,
 * increment, then insert the invoice — guarantees no gaps within a series.
 */
export const invoiceSequenceCounters = pgTable(
  'invoice_sequence_counters',
  {
    legalEntityId: text('legal_entity_id').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    series: text('series').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.legalEntityId, t.fiscalYear, t.series] }),
  }),
);

/**
 * Credit note: parallel sequence to the parent invoice. Carries its own PII legal-hold snap
 * fields (mirrors the invoice). Written when an accepted refund needs to back out tax/TCS.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: text('id').primaryKey(),
    parentInvoiceId: text('parent_invoice_id')
      .notNull()
      .references(() => invoices.id),
    refundId: text('refund_id').references(() => refunds.id),
    legalEntityId: text('legal_entity_id').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    series: text('series').notNull(),
    sequenceNo: integer('sequence_no').notNull(),
    creditNoteNumber: text('credit_note_number').notNull(),

    // PII LEGAL HOLD
    consumerNameSnap: text('consumer_name_snap').notNull(),
    consumerBillingAddressSnap: text('consumer_billing_address_snap').notNull(),
    consumerGstinSnap: text('consumer_gstin_snap'),

    reason: text('reason').notNull(),
    subtotalReversedPaise: integer('subtotal_reversed_paise').notNull(),
    taxReversedPaise: integer('tax_reversed_paise').notNull(),
    tcsReversedPaise: integer('tcs_reversed_paise').notNull().default(0),
    grandTotalReversedPaise: integer('grand_total_reversed_paise').notNull(),
    pdfUrl: text('pdf_url'),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    seqUniqueIdx: uniqueIndex('credit_notes_seq_unique_idx').on(
      t.legalEntityId,
      t.fiscalYear,
      t.series,
      t.sequenceNo,
    ),
    parentInvoiceIdx: index('credit_notes_parent_invoice_idx').on(t.parentInvoiceId),
  }),
);

/**
 * Retailer payout per cycle. Aggregates kept-order revenue net of platform commission,
 * GST on commission (TCS), and held refunds. `gatewayPayoutId` is the bank-transfer
 * reference once initiated.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    cycleStart: timestamp('cycle_start', { withTimezone: true, mode: 'date' }).notNull(),
    cycleEnd: timestamp('cycle_end', { withTimezone: true, mode: 'date' }).notNull(),
    // bigint — payout aggregates can grow past the 32-bit signed ceiling for high-volume stores.
    grossPaise: bigint('gross_paise', { mode: 'bigint' }).notNull(),
    commissionPaise: bigint('commission_paise', { mode: 'bigint' }).notNull(),
    commissionTaxPaise: bigint('commission_tax_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    refundsHeldPaise: bigint('refunds_held_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    adjustmentsPaise: bigint('adjustments_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    netPaise: bigint('net_paise', { mode: 'bigint' }).notNull(),
    // §18 — sum of active payout_holds bound to this payout at creation time.
    disputeHoldPaise: bigint('dispute_hold_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id),
    status: payoutStatus('status').notNull().default('pending'),
    statementUrl: text('statement_url'),
    gatewayPayoutId: text('gateway_payout_id'),
    // §18 — bank reconciliation metadata (set on mark-complete).
    bankConfirmationRef: text('bank_confirmation_ref'),
    bankConfirmedAt: timestamp('bank_confirmed_at', { withTimezone: true, mode: 'date' }),
    // §18 — failure reason + retry chain.
    failureReason: text('failure_reason'),
    retryCount: integer('retry_count').notNull().default(0),
    previousPayoutId: text('previous_payout_id'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // ERD hot index: payout(store_id, status, cycle_end) — drives the retailer payouts dashboard
    storeStatusCycleIdx: index('payouts_store_status_cycle_idx').on(
      t.storeId,
      t.status,
      t.cycleEnd,
    ),
    cycleRangeGuard: check('payouts_cycle_range_guard', sql`${t.cycleEnd} > ${t.cycleStart}`),
    grossNonNegativeGuard: check('payouts_gross_non_negative', sql`${t.grossPaise} >= 0`),
    completedAtGuard: check(
      'payouts_completed_at_guard',
      sql`${t.status} <> 'completed' OR ${t.completedAt} IS NOT NULL`,
    ),
  }),
);

/**
 * Per-legal-entity invoice numbering rules. Stored separately from the sequence counter
 * so prefix/pattern can be edited without resetting sequences.
 */
export const invoiceNumberingRules = pgTable('invoice_numbering_rules', {
  legalEntityId: text('legal_entity_id').primaryKey(),
  legalEntityName: text('legal_entity_name').notNull(),
  prefix: text('prefix').notNull().default('INV'),
  pattern: text('pattern').notNull().default('{PREFIX}-{YYYY}-{SEQ}'),
  resetCycle: invoiceResetCycle('reset_cycle').notNull().default('fiscal_year'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * GST return file records. One row per (period, kind). Admin triggers generation;
 * status tracks background job; downloadUrl is set when ready.
 */
export const gstReturnFiles = pgTable(
  'gst_return_files',
  {
    id: text('id').primaryKey(),
    period: text('period').notNull(), // e.g. "2026-04"
    kind: gstReturnKind('kind').notNull(),
    status: gstReturnStatus('status').notNull().default('pending'),
    downloadUrl: text('download_url'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    periodKindIdx: index('gst_return_files_period_kind_idx').on(t.period, t.kind),
  }),
);

/**
 * Post-payout recoveries: refunds issued after the payout that covered the order has settled.
 * A planned row debits the amount from the store's next payout cycle.
 */
export const postPayoutRecoveries = pgTable(
  'post_payout_recoveries',
  {
    id: text('id').primaryKey(),
    refundId: text('refund_id').notNull().references(() => refunds.id),
    orderId: text('order_id').notNull().references(() => orders.id),
    storeId: text('store_id').notNull().references(() => retailerStores.id),
    payoutCycleId: text('payout_cycle_id').references(() => payouts.id),
    refundedPaise: integer('refunded_paise').notNull(),
    plannedDebitPaise: integer('planned_debit_paise').notNull(),
    status: postPayoutRecoveryStatus('status').notNull().default('planned'),
    reason: text('reason'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    storeStatusIdx: index('post_payout_recoveries_store_status_idx').on(t.storeId, t.status),
  }),
);

/**
 * Off-cycle payout requests. Retailer asks to pull settled balance early; admin approves/rejects.
 */
export const earlyDisbursementRequests = pgTable(
  'early_disbursement_requests',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    amountPaise: integer('amount_paise').notNull(),
    reason: text('reason').notNull(),
    status: earlyDisbursementStatus('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByAccountId: text('decided_by_account_id'),
    decisionNote: text('decision_note'),
  },
  (t) => ({
    storeStatusIdx: index('early_disbursement_requests_store_status_idx').on(t.storeId, t.status),
  }),
);

// ===== Relations =====

export const earlyDisbursementRequestsRelations = relations(earlyDisbursementRequests, ({ one }) => ({
  store: one(retailerStores, {
    fields: [earlyDisbursementRequests.storeId],
    references: [retailerStores.id],
  }),
}));

export const postPayoutRecoveriesRelations = relations(postPayoutRecoveries, ({ one }) => ({
  store: one(retailerStores, {
    fields: [postPayoutRecoveries.storeId],
    references: [retailerStores.id],
  }),
  refund: one(refunds, {
    fields: [postPayoutRecoveries.refundId],
    references: [refunds.id],
  }),
  order: one(orders, {
    fields: [postPayoutRecoveries.orderId],
    references: [orders.id],
  }),
  payoutCycle: one(payouts, {
    fields: [postPayoutRecoveries.payoutCycleId],
    references: [payouts.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  order: one(orders, { fields: [invoices.orderId], references: [orders.id] }),
  store: one(retailerStores, { fields: [invoices.storeId], references: [retailerStores.id] }),
  creditNotes: many(creditNotes),
}));

export const creditNotesRelations = relations(creditNotes, ({ one }) => ({
  parentInvoice: one(invoices, {
    fields: [creditNotes.parentInvoiceId],
    references: [invoices.id],
  }),
  refund: one(refunds, {
    fields: [creditNotes.refundId],
    references: [refunds.id],
  }),
}));

export const payoutsRelations = relations(payouts, ({ one, many }) => ({
  store: one(retailerStores, {
    fields: [payouts.storeId],
    references: [retailerStores.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [payouts.bankAccountId],
    references: [bankAccounts.id],
  }),
  holds: many(payoutHolds),
  adjustments: many(payoutAdjustments),
  transitions: many(payoutTransitions),
}));

/**
 * §18 — Append-only audit row per payout state change. Mirrors orderTransitions.
 */
export const payoutTransitions = pgTable(
  'payout_transitions',
  {
    id: text('id').primaryKey(),
    payoutId: text('payout_id')
      .notNull()
      .references(() => payouts.id),
    fromStatus: payoutStatus('from_status'),
    toStatus: payoutStatus('to_status').notNull(),
    actorType: text('actor_type').notNull(), // admin | system
    actorId: text('actor_id').notNull(),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    payoutAtIdx: index('payout_transitions_payout_at_idx').on(t.payoutId, t.at),
  }),
);

/**
 * §18 — Hold tied to an open dispute. Auto-released when dispute resolves (helper exists; manual
 * for MVP). When `payoutId` is set, the amount is bound to that cycle and rolled into payouts.disputeHoldPaise.
 */
export const payoutHolds = pgTable(
  'payout_holds',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    disputeId: text('dispute_id').notNull(),
    payoutId: text('payout_id').references(() => payouts.id),
    amountPaise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    status: payoutHoldStatus('status').notNull().default('active'),
    createdByAdminId: text('created_by_admin_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    releasedReason: text('released_reason'),
  },
  (t) => ({
    storeStatusIdx: index('payout_holds_store_status_idx').on(t.storeId, t.status),
    disputeIdx: index('payout_holds_dispute_idx').on(t.disputeId),
  }),
);

export const payoutHoldsRelations = relations(payoutHolds, ({ one }) => ({
  store: one(retailerStores, { fields: [payoutHolds.storeId], references: [retailerStores.id] }),
  payout: one(payouts, { fields: [payoutHolds.payoutId], references: [payouts.id] }),
}));

/**
 * §18 — Free-form debit/credit adjustments applied by ops to a store's next or specific cycle.
 * `payoutId` null = will be picked up by the next runCycle.
 */
export const payoutAdjustments = pgTable(
  'payout_adjustments',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    payoutId: text('payout_id').references(() => payouts.id),
    direction: payoutAdjustmentDirection('direction').notNull(),
    kind: payoutAdjustmentKind('kind').notNull().default('manual'),
    amountPaise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    sourceIssueId: text('source_issue_id'),
    createdByAdminId: text('created_by_admin_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    storePayoutIdx: index('payout_adjustments_store_payout_idx').on(t.storeId, t.payoutId),
    kindIdx: index('payout_adjustments_kind_idx').on(t.kind),
  }),
);

export const payoutAdjustmentsRelations = relations(payoutAdjustments, ({ one }) => ({
  store: one(retailerStores, { fields: [payoutAdjustments.storeId], references: [retailerStores.id] }),
  payout: one(payouts, { fields: [payoutAdjustments.payoutId], references: [payouts.id] }),
}));

export const payoutTransitionsRelations = relations(payoutTransitions, ({ one }) => ({
  payout: one(payouts, { fields: [payoutTransitions.payoutId], references: [payouts.id] }),
}));

/**
 * §18 — Monthly billing statement per (store, period). One row per store per YYYY-MM, summarising
 * commission + GST on commission + add-on fees + TCS + dispute liabilities + adjustments → net payout.
 */
export const billingStatements = pgTable(
  'billing_statements',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    legalEntityId: text('legal_entity_id').notNull(),
    period: text('period').notNull(), // YYYY-MM
    commissionPaise: bigint('commission_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    commissionTaxPaise: bigint('commission_tax_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    addOnFeesPaise: bigint('add_on_fees_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    tcsPaise: bigint('tcs_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    disputeLiabilitiesPaise: bigint('dispute_liabilities_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    adjustmentsPaise: bigint('adjustments_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    netPayoutPaise: bigint('net_payout_paise', { mode: 'bigint' }).notNull().default(sql`0`),
    pdfUrl: text('pdf_url'),
    status: billingStatementStatus('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    storePeriodUnique: uniqueIndex('billing_statements_store_period_unique').on(t.storeId, t.period),
  }),
);

export const billingStatementsRelations = relations(billingStatements, ({ one }) => ({
  store: one(retailerStores, { fields: [billingStatements.storeId], references: [retailerStores.id] }),
}));
