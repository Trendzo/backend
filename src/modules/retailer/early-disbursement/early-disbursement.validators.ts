import { z } from 'zod';

export const CreateRequestBody = z.object({
  amountPaise: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
});
