import { z } from 'zod';

/** Omit amountPaise to deposit the full outstanding balance. */
export const RequestDepositBody = z.object({
  amountPaise: z.number().int().positive().optional(),
  note: z.string().trim().max(300).optional(),
});
