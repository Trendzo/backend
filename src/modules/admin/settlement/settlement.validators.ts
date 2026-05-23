import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const PayoutListQuery = z.object({
  storeId: z.string().optional(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'must be YYYY-MM-DD or ISO timestamp');

export const PayoutPreviewBody = z.object({
  storeId: z.string().min(1),
  cycleStart: isoDate,
  cycleEnd: isoDate,
});

export const PayoutRunBody = z.object({
  storeId: z.string().min(1),
  cycleStart: isoDate,
  cycleEnd: isoDate,
  bankAccountId: z.string().min(1),
});

export const MarkCompleteBody = z.object({
  bankConfirmationRef: z.string().trim().min(1).max(80),
});

export const MarkFailedBody = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const BillingCloseBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
});

export const BillingStatementsQuery = z.object({
  storeId: z.string().optional(),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
