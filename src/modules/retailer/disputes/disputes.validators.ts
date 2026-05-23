import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListDisputesQuery = z.object({
  status: z.enum(['open', 'requested_evidence', 'decided', 'escalated']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
