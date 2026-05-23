import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const CreateHoldBody = z.object({
  storeId: z.string().min(1),
  disputeId: z.string().min(1),
  amountPaise: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});

export const ReleaseHoldBody = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const ListHoldsQuery = z.object({
  storeId: z.string().optional(),
  status: z.enum(['active', 'released']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
