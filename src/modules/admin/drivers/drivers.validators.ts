import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const DepositParams = z.object({ id: z.string(), depositId: z.string() });

export const ListDriversQuery = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
});

export const ListDepositsQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
});

export const DecideDepositBody = z.object({
  note: z.string().trim().max(300).optional(),
});
