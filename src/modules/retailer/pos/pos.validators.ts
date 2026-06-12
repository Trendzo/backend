import { z } from 'zod';

export const LookupQuery = z.object({
  q: z.string().min(1).max(120),
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

export const CustomersQuery = z.object({ phone: z.string().min(3).max(20) });

export const SummaryQuery = z.object({ date: z.string().optional() }); // YYYY-MM-DD
