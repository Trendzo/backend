import { z } from 'zod';

export const LegalEntityParam = z.object({ legalEntityId: z.string() });

export const UpdateNumberingBody = z.object({
  prefix: z.string().trim().min(1).max(20).optional(),
  pattern: z.string().trim().min(1).max(100).optional(),
  resetCycle: z.enum(['never', 'fiscal_year', 'monthly']).optional(),
});

export const GenerateGstReturnBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM'),
  kind: z.enum(['gstr1', 'gstr3b', 'tcs_reconciliation']),
});

export const IssueInvoiceBody = z.object({
  orderId: z.string().trim().min(1),
  kind: z.enum(['tax_invoice', 'supplementary_invoice']).default('tax_invoice'),
  heldItemId: z.string().trim().min(1).optional(),
});

export const IssueCreditNoteBody = z.object({
  refundId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
});

export const IssueCommissionInvoiceBody = z.object({
  orderId: z.string().trim().min(1),
});
