import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListDecisionsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const RejectBody = z.object({
  reason: z.string().trim().min(3).max(500),
});
