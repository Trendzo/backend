import { z } from 'zod';

export const RedeemBody = z.object({
  code: z.string().trim().min(1).max(40),
});
