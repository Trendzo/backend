import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const FeesUpdateBody = z.object({
  baseDeliveryFee: z
    .object({
      express: z.number().int().nonnegative().optional(),
      standard: z.number().int().nonnegative().optional(),
      pickup: z.number().int().nonnegative().optional(),
      try_and_buy: z.number().int().nonnegative().optional(),
    })
    .optional(),
  surgeMultiplier: z.number().positive().max(10).optional(),
  tcsRateBp: z.number().int().nonnegative().max(10000).optional(),
});

export const FeeOverrideBody = z.object({
  platformFeeBp: z.number().int().min(0).max(10000),
  reason: z.string().trim().min(3).max(500),
});
