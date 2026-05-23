import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListWalletPayoutsQuery = z.object({
  status: z
    .enum(['pending_claim', 'awaiting_bank', 'paid', 'escheated', 'failed'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
