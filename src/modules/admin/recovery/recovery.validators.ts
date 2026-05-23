import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListRecoveriesQuery = z.object({
  status: z.enum(['planned', 'debited', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
