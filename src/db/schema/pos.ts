import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { posPricingMode, posSaleStatus, posTenderMethod, taxSplitKind } from './enums.js';
import { invoices } from './invoicing.js';
import { productListings, variants } from './products.js';
import { retailerAccounts, retailerStores } from './store.js';

/**
 * Offline POS (counter sales) — the retailer's OWN in-store sale, settled instantly.
 *
 * This is a SEPARATE ledger from marketplace `orders`: no consumer account, no delivery,
 * no platform commission, no TCS, not part of the weekly payout cycle. The only things it
 * shares with the marketplace are INVENTORY (`variants.stock`, decremented on completion)
 * and the INVOICES table (a `pos_tax_invoice` issued from the store's own GSTIN to a
 * walk-in customer; place of supply = store state ⇒ always intra-state CGST+SGST).
 *
 * Snapshot discipline mirrors `orders`: store + customer details and per-line product data
 * are frozen onto the sale at completion so a reprint is always reproducible.
 */

/**
 * Optional walk-in customer profile, for repeat-customer lookup by phone. Customer details
 * are ALSO snapshotted directly onto `pos_sales` (so a sale needs no customer row at all).
 */
export const posCustomers = pgTable(
  'pos_customers',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    name: text('name'),
    phone: text('phone'),
    gstin: text('gstin'), // B2B — drives consumerGstinSnap on the invoice
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    storePhoneIdx: index('pos_customers_store_phone_idx').on(t.storeId, t.phone),
  }),
);

/**
 * Bill head. A `held` row is a parked bill (no stock moved); `completed` means settled
 * (stock decremented + invoice issued); `voided` reverses a completed sale same-day.
 *
 * All money is paise (int). `roundOffPaise` is SIGNED and lives only here — it can never go
 * on the GST invoice (the invoice check requires grandTotal = taxable + cgst + sgst + tcs).
 */
export const posSales = pgTable(
  'pos_sales',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    cashierAccountId: text('cashier_account_id')
      .notNull()
      .references(() => retailerAccounts.id),
    customerId: text('customer_id').references(() => posCustomers.id),
    status: posSaleStatus('status').notNull().default('held'),
    note: text('note'), // optional label for a parked bill

    // Walk-in customer snapshot (all optional)
    customerNameSnap: text('customer_name_snap'),
    customerPhoneSnap: text('customer_phone_snap'),
    customerGstinSnap: text('customer_gstin_snap'),

    // Store snapshot (frozen at completion)
    storeLegalNameSnap: text('store_legal_name_snap').notNull(),
    storeGstinSnap: text('store_gstin_snap').notNull(),
    storeStateCodeSnap: text('store_state_code_snap').notNull(),
    storeAddressSnap: text('store_address_snap').notNull(),

    taxSplitKind: taxSplitKind('tax_split_kind').notNull().default('intra_state'),
    pricingMode: posPricingMode('pricing_mode').notNull().default('tax_inclusive'),

    // Totals (paise)
    itemsGrossPaise: integer('items_gross_paise').notNull().default(0),
    lineDiscountPaise: integer('line_discount_paise').notNull().default(0),
    billDiscountPaise: integer('bill_discount_paise').notNull().default(0),
    taxableValuePaise: integer('taxable_value_paise').notNull().default(0),
    cgstPaise: integer('cgst_paise').notNull().default(0),
    sgstPaise: integer('sgst_paise').notNull().default(0),
    igstPaise: integer('igst_paise').notNull().default(0),
    taxPaise: integer('tax_paise').notNull().default(0),
    roundOffPaise: integer('round_off_paise').notNull().default(0), // signed
    payablePaise: integer('payable_paise').notNull().default(0),
    tenderedPaise: integer('tendered_paise').notNull().default(0),
    changePaise: integer('change_paise').notNull().default(0),

    invoiceId: text('invoice_id').references(() => invoices.id),
    // Set when this sale is a return/exchange against a prior completed sale.
    originalSaleId: text('original_sale_id'),

    idempotencyKey: text('idempotency_key').notNull(),
    voidReason: text('void_reason'),

    heldAt: timestamp('held_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyIdx: uniqueIndex('pos_sales_idempotency_idx').on(t.idempotencyKey),
    storeStatusCreatedIdx: index('pos_sales_store_status_created_idx').on(
      t.storeId,
      t.status,
      t.createdAt,
    ),
    storeCompletedIdx: index('pos_sales_store_completed_idx').on(t.storeId, t.completedAt),
    cashierIdx: index('pos_sales_cashier_idx').on(t.cashierAccountId),
    // GST split must match jurisdiction (same invariant as orders/invoices).
    gstSplitGuard: check(
      'pos_sales_gst_split_guard',
      sql`(${t.taxSplitKind} = 'intra_state' AND ${t.igstPaise} = 0 AND ${t.cgstPaise} + ${t.sgstPaise} = ${t.taxPaise})
        OR (${t.taxSplitKind} = 'inter_state' AND ${t.cgstPaise} = 0 AND ${t.sgstPaise} = 0 AND ${t.igstPaise} = ${t.taxPaise})`,
    ),
    // A completed sale must have collected at least the payable amount.
    tenderedGuard: check(
      'pos_sales_tendered_guard',
      sql`${t.status} <> 'completed' OR ${t.tenderedPaise} >= ${t.payablePaise}`,
    ),
  }),
);

/**
 * Bill line. One row per (sale, variant). Carries product snapshots so the invoice reprint
 * never depends on the live catalog. `qty > 0` always — a return is a separate sale row, not
 * a negative line.
 */
export const posSaleItems = pgTable(
  'pos_sale_items',
  {
    id: text('id').primaryKey(),
    saleId: text('sale_id')
      .notNull()
      .references(() => posSales.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id),

    // Snapshots
    listingNameSnap: text('listing_name_snap').notNull(),
    brandSnap: text('brand_snap'),
    categorySnap: text('category_snap'),
    attributesLabelSnap: text('attributes_label_snap').notNull(),
    hsnSnap: text('hsn_snap'),
    skuSnap: text('sku_snap'),
    barcodeSnap: text('barcode_snap'),

    qty: integer('qty').notNull(),
    unitMrpPaise: integer('unit_mrp_paise').notNull(), // sticker price (tax-incl when pricingMode=inclusive)
    lineGrossPaise: integer('line_gross_paise').notNull(), // unitMrp * qty
    lineDiscountPaise: integer('line_discount_paise').notNull().default(0),
    gstRateBp: integer('gst_rate_bp').notNull(), // 500 = 5%, 1200 = 12%, 1800 = 18%
    taxableValuePaise: integer('taxable_value_paise').notNull(),
    gstPaise: integer('gst_paise').notNull(),
    netLinePaise: integer('net_line_paise').notNull(), // taxable + gst (what this line adds to payable)
  },
  (t) => ({
    saleIdx: index('pos_sale_items_sale_idx').on(t.saleId),
    variantIdx: index('pos_sale_items_variant_idx').on(t.variantId),
    qtyGuard: check('pos_sale_items_qty_guard', sql`${t.qty} > 0 AND ${t.unitMrpPaise} > 0`),
  }),
);

/**
 * Tender row. Split payments = multiple rows whose `amountPaise` sum to the sale's payable.
 * `direction` = 'collect' for a sale, 'refund' for a return's refund leg.
 */
export const posPayments = pgTable(
  'pos_payments',
  {
    id: text('id').primaryKey(),
    saleId: text('sale_id')
      .notNull()
      .references(() => posSales.id, { onDelete: 'cascade' }),
    method: posTenderMethod('method').notNull(),
    direction: text('direction').notNull().default('collect'), // 'collect' | 'refund'
    amountPaise: integer('amount_paise').notNull(),
    tenderedPaise: integer('tendered_paise'), // cash given (cash only)
    changePaise: integer('change_paise').notNull().default(0),
    reference: text('reference'), // card/UPI txn ref, last-4, etc.
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    saleIdx: index('pos_payments_sale_idx').on(t.saleId),
  }),
);

/**
 * Per-line link from a return sale back to the original sale's line, with restock intent.
 */
export const posReturnLines = pgTable(
  'pos_return_lines',
  {
    id: text('id').primaryKey(),
    returnSaleId: text('return_sale_id')
      .notNull()
      .references(() => posSales.id, { onDelete: 'cascade' }),
    originalSaleItemId: text('original_sale_item_id')
      .notNull()
      .references(() => posSaleItems.id),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id),
    qty: integer('qty').notNull(),
    refundPaise: integer('refund_paise').notNull(),
    restock: boolean('restock').notNull().default(true),
  },
  (t) => ({
    returnSaleIdx: index('pos_return_lines_return_sale_idx').on(t.returnSaleId),
    qtyGuard: check('pos_return_lines_qty_guard', sql`${t.qty} > 0`),
  }),
);

// ===== Relations =====

export const posCustomersRelations = relations(posCustomers, ({ one, many }) => ({
  store: one(retailerStores, { fields: [posCustomers.storeId], references: [retailerStores.id] }),
  sales: many(posSales),
}));

export const posSalesRelations = relations(posSales, ({ one, many }) => ({
  store: one(retailerStores, { fields: [posSales.storeId], references: [retailerStores.id] }),
  cashier: one(retailerAccounts, {
    fields: [posSales.cashierAccountId],
    references: [retailerAccounts.id],
  }),
  customer: one(posCustomers, { fields: [posSales.customerId], references: [posCustomers.id] }),
  invoice: one(invoices, { fields: [posSales.invoiceId], references: [invoices.id] }),
  items: many(posSaleItems),
  payments: many(posPayments),
  returnLines: many(posReturnLines),
}));

export const posSaleItemsRelations = relations(posSaleItems, ({ one }) => ({
  sale: one(posSales, { fields: [posSaleItems.saleId], references: [posSales.id] }),
  listing: one(productListings, {
    fields: [posSaleItems.listingId],
    references: [productListings.id],
  }),
  variant: one(variants, { fields: [posSaleItems.variantId], references: [variants.id] }),
}));

export const posPaymentsRelations = relations(posPayments, ({ one }) => ({
  sale: one(posSales, { fields: [posPayments.saleId], references: [posSales.id] }),
}));

export const posReturnLinesRelations = relations(posReturnLines, ({ one }) => ({
  returnSale: one(posSales, { fields: [posReturnLines.returnSaleId], references: [posSales.id] }),
  originalItem: one(posSaleItems, {
    fields: [posReturnLines.originalSaleItemId],
    references: [posSaleItems.id],
  }),
  variant: one(variants, { fields: [posReturnLines.variantId], references: [variants.id] }),
}));
