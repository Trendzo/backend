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
import { invoiceKind, invoiceStatus, payoutStatus, taxSplitKind } from './enums.js';
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
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id),
    status: payoutStatus('status').notNull().default('pending'),
    statementUrl: text('statement_url'),
    gatewayPayoutId: text('gateway_payout_id'),
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

// ===== Relations =====

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

export const payoutsRelations = relations(payouts, ({ one }) => ({
  store: one(retailerStores, {
    fields: [payouts.storeId],
    references: [retailerStores.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [payouts.bankAccountId],
    references: [bankAccounts.id],
  }),
}));
