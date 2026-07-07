import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListDriversQuery = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
});
