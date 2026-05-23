import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const CreateAdjustmentBody = z.object({
  storeId: z.string().min(1),
  direction: z.enum(['debit', 'credit']),
  amountPaise: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});

export const ListAdjustmentsQuery = z.object({
  storeId: z.string().optional(),
  payoutId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
