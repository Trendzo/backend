import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListInvoicesQuery = z.object({
  kind: z.enum(['invoice', 'supplementary', 'commission', 'all']).default('all'),
  orderId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
