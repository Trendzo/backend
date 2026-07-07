import { z } from 'zod';

export const LookupQuery = z.object({
  q: z.string().min(1).max(120),
});

// ── QR scan → register (mobile app scans, web register receives over SSE) ──

/** Resolve a scanned QR/barcode to a product row (for the app's confirm card). */
export const ResolveScanQuery = z.object({
  code: z.string().min(1).max(200),
});

/** Push a confirmed scan to a chosen open register. `target` is a session id or "all". */
export const ScanBody = z.object({
  variantId: z.string().min(1),
  target: z.string().min(1).max(120),
  qty: z.number().int().min(1).max(99).default(1),
});

const LineSchema = z.object({
  variantId: z.string().min(1),
  qty: z.number().int().positive(),
  lineDiscountPaise: z.number().int().min(0).optional(),
});

const CustomerSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().max(160).nullish(),
  phone: z.string().max(20).nullish(),
  gstin: z.string().max(20).nullish(),
});

const TenderSchema = z.object({
  method: z.enum(['cash', 'card', 'upi']),
  amountPaise: z.number().int().min(0),
  tenderedPaise: z.number().int().min(0).optional(),
  reference: z.string().max(120).optional(),
});

const PricingMode = z.enum(['tax_inclusive', 'tax_exclusive']);

export const QuoteBody = z.object({
  lines: z.array(LineSchema).min(1),
  billDiscountPaise: z.number().int().min(0).optional(),
  pricingMode: PricingMode.optional(),
});

export const CreateSaleBody = z.object({
  idempotencyKey: z.string().min(8).max(120),
  holdSaleId: z.string().min(1).optional(),
  customer: CustomerSchema.optional(),
  pricingMode: PricingMode.optional(),
  billDiscountPaise: z.number().int().min(0).optional(),
  note: z.string().max(240).optional(),
  lines: z.array(LineSchema).min(1),
  tenders: z.array(TenderSchema).min(1),
});

export const HoldSaleBody = z.object({
  idempotencyKey: z.string().min(8).max(120),
  customer: CustomerSchema.optional(),
  pricingMode: PricingMode.optional(),
  billDiscountPaise: z.number().int().min(0).optional(),
  note: z.string().max(240).optional(),
  lines: z.array(LineSchema).min(1),
});

export const VoidSaleBody = z.object({
  reason: z.string().min(1).max(240),
});

export const ReturnSaleBody = z.object({
  idempotencyKey: z.string().min(8).max(120),
  reason: z.string().min(1).max(240),
  lines: z
    .array(
      z.object({
        originalSaleItemId: z.string().min(1),
        qty: z.number().int().positive(),
        restock: z.boolean().optional(),
      }),
    )
    .min(1),
  refundTenders: z.array(TenderSchema).min(1),
});

/**
 * Exchange: hand back original line(s) + sell replacement variant(s). Server computes the
 * net and validates exactly one settlement side — `collectTenders` when the customer owes,
 * `refundTenders` when the store pays back, neither for an even swap.
 */
export const ExchangeSaleBody = z.object({
  idempotencyKey: z.string().min(8).max(120),
  reason: z.string().min(1).max(240),
  returnLines: z
    .array(
      z.object({
        originalSaleItemId: z.string().min(1),
        qty: z.number().int().positive(),
        restock: z.boolean().optional(),
      }),
    )
    .min(1),
  newLines: z.array(LineSchema).min(1),
  collectTenders: z.array(TenderSchema).optional(),
  refundTenders: z.array(TenderSchema).optional(),
  pricingMode: PricingMode.optional(),
});

export const ListSalesQuery = z.object({
  status: z.enum(['held', 'completed', 'voided']).optional(),
  from: z.string().optional(), // ISO date
  to: z.string().optional(),
  cashierId: z.string().optional(),
  tender: z.enum(['cash', 'card', 'upi']).optional(),
  q: z.string().optional(), // invoice number search
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IdParam = z.object({ id: z.string().min(1) });

// ───────────────────────── printer / cash drawer ─────────────────────────

/** Upsert body for a store's printer + cash-drawer config. All fields optional (partial update). */
export const PrinterConfigBody = z.object({
  enabled: z.boolean().optional(),
  connection: z.enum(['network', 'client', 'browser']).optional(),
  host: z.string().max(255).nullish(),
  port: z.number().int().min(1).max(65535).optional(),
  paperWidth: z.union([z.literal(58), z.literal(80)]).optional(),
  charsPerLine: z.number().int().min(24).max(64).optional(),
  copies: z.number().int().min(1).max(5).optional(),
  headerText: z.string().max(500).nullish(),
  footerText: z.string().max(500).nullish(),
  showGstBreakup: z.boolean().optional(),
  showQr: z.boolean().optional(),
  autoPrintOnSale: z.boolean().optional(),
  cashDrawerEnabled: z.boolean().optional(),
  cashDrawerPin: z.union([z.literal(0), z.literal(1)]).optional(),
  cashDrawerOnlyOnCash: z.boolean().optional(),
  cashDrawerOnSale: z.boolean().optional(),
});

/** ?format= for the reprint endpoint. `pdf` returns the stored GST-invoice URL. */
export const ReceiptQuery = z.object({
  format: z.enum(['json', 'text', 'escpos', 'pdf']).default('json'),
});

/** Trigger a server-side network reprint; optionally pop the drawer with it. */
export const PrintSaleBody = z.object({
  openDrawer: z.boolean().optional(),
});

export const CustomersQuery = z.object({ phone: z.string().min(3).max(20) });

export const SummaryQuery = z.object({ date: z.string().optional() }); // YYYY-MM-DD

// Day open/close (cash reconciliation)
const DateOpt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
export const DayCurrentQuery = z.object({ date: DateOpt });
export const DayOpenBody = z.object({
  openingFloatPaise: z.number().int().min(0),
  date: DateOpt,
});
export const DayCloseBody = z.object({
  countedCashPaise: z.number().int().min(0),
  note: z.string().trim().max(240).optional(),
  date: DateOpt,
});
